const admin = require('firebase-admin');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

// Firebase 초기화
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase 연결 성공');
} catch (error) {
  console.error('❌ Firebase 초기화 실패:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Claude AI 초기화
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// 키워드 분류
const PRIMARY_KEYWORDS = [
  '공모전', '팀플', '팀프로젝트', '대회', '세미나', '조별과제', '협업',
  '컬래버레이션', '콜라보', '워크샵', '해커톤', '프로젝트팀', '동아리', '학회'
];

const SECONDARY_KEYWORDS = [
  '주도', '조장', '역할분담', '리더십', '책임',
  '단체', '연합', '연대', '총회', '회의', '소통', '의사결정', '협력'
];

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
}

async function isDuplicate(link) {
  const snapshot = await db.collection('cases').where('link', '==', link).limit(1).get();
  return !snapshot.empty;
}

// ========== 블로그 필터링 (우선순위별) ==========
function filterBlog(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  
  // 1순위: '공모전' AND '후기'
  if (text.includes('공모전') && text.includes('후기')) {
    return { pass: true, priority: 1, reason: '공모전+후기' };
  }
  
  // 2순위: '공모전'만
  if (text.includes('공모전')) {
    return { pass: true, priority: 2, reason: '공모전' };
  }
  
  // 3순위: '팀' AND '참여' AND '후기'
  if (text.includes('팀') && text.includes('참여') && text.includes('후기')) {
    return { pass: true, priority: 3, reason: '팀+참여+후기' };
  }
  
  return { pass: false, priority: 0, reason: '필터 불통과' };
}

// ========== 뉴스 필터링 ==========
function filterNews(title, description) {
  const text = title + ' ' + description;
  
  // 키워드 체크
  const hasKeyword = ['추진', '결정', '논의'].some(k => text.includes(k));
  if (!hasKeyword) {
    return { pass: false, reason: '키워드 없음' };
  }
  
  // 고유명사(2-4글자 한글) 빈도 체크
  const words = text.match(/[가-힣]{2,4}/g) || [];
  const wordCount = {};
  
  words.forEach(word => {
    // 일반 단어 제외
    const commonWords = ['하는', '있는', '없는', '되는', '이를', '그는', '같은', '위한', '대한', '등의'];
    if (commonWords.includes(word)) return;
    
    wordCount[word] = (wordCount[word] || 0) + 1;
  });
  
  // 3번 이상 반복되는 단어가 있는지
  const repeated = Object.entries(wordCount).filter(([word, count]) => count >= 3);
  
  if (repeated.length > 0) {
    return { 
      pass: true, 
      entities: repeated.map(([word, count]) => `${word}(${count}회)`).join(', '),
      reason: '인물/기관명 반복 + 키워드'
    };
  }
  
  return { pass: false, reason: '반복 단어 부족' };
}

// Claude로 케이스 분석
async function analyzeWithClaude(title, description) {
  const prompt = `다음은 팀 프로젝트나 협업에 관한 블로그/뉴스 내용입니다.

제목: ${title}
내용: ${description}

다음 기준으로 분석해주세요:

1. **행위 주체 추출** (누가 이 행동을 했는지 구체적으로)
   - 예시: "컴공 학생", "스타트업 기획자", "정치인", "대학원생", "마케터" 등
   - 일반적인 "학생", "직장인"보다는 더 구체적으로 추출
   - 신뢰도 점수 (0-100)

2. **팀플레이 유형 분류** (긍정적인 행동만!)
   다음 16가지 긍정 유형 중 해당되는 것:
   
   리더십 계열: 주도형, 비전제시형, 전략가형
   실행 계열: 실행형, 완수형, 속도형
   협업 계열: 협력형, 조율자형, 지원형
   소통 계열: 소통형, 경청형, 중재형
   혁신 계열: 혁신형, 창의형, 분석형
   안정 계열: 신뢰구축형
   
   - 부정적 내용(무임승차, 갈등, 독단 등)은 제외
   - 부정적 상황을 극복한 경우는 긍정 유형으로 분류 가능
   - 신뢰도 점수 (0-100)

3. **1차 카테고리** (주제 분류)
   정치, 사회, 경제, 과학, 공학, 의료, 교육, 문화, 스포츠, 환경, 기술, 기타
   - 신뢰도 점수

4. **발췌 부분** 
   - 원문에서 팀플레이 행동이 가장 잘 드러나는 1-2문장 추출

5. **분류 근거**
   - 왜 이 주체로 판단했는지
   - 왜 이 유형으로 판단했는지
   - 긍정적 행동인 이유

다음 JSON 형식으로만 답변해주세요 (다른 설명 없이):
{
  "actor": {
    "label": "구체적 행위 주체",
    "confidence": 85,
    "alternatives": ["대안1", "대안2"]
  },
  "teamType": {
    "label": "팀플 유형",
    "category": "리더십/실행/협업/소통/혁신/안정",
    "confidence": 80,
    "alternatives": ["대안유형1", "대안유형2"]
  },
  "primaryCategory": {
    "label": "카테고리명",
    "confidence": 90
  },
  "excerpt": "원문 발췌 1-2문장",
  "reason": {
    "actorReason": "주체 판단 근거",
    "typeReason": "유형 판단 근거",
    "isPositive": true
  }
}

만약 이 내용이 팀플레이와 관련 없거나 부정적 내용만 있다면:
{ "isRelevant": false, "reason": "이유" }`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    const text = message.content[0].text;
    
    // JSON 파싱
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('⚠️ JSON 파싱 실패:', text.substring(0, 100));
      return null;
    }
    
    const analysis = JSON.parse(jsonMatch[0]);
    
    // 관련 없는 내용 필터링
    if (analysis.isRelevant === false) {
      return null;
    }
    
    return analysis;
  } catch (error) {
    console.error('❌ Claude 분석 오류:', error.message);
    return null;
  }
}

// 네이버 블로그 검색
async function searchNaverBlog(keyword) {
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
      params: { 
        query: keyword, 
        display: 100,
        sort: 'sim'
      },
      headers: { 
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET 
      }
    });
    return response.data.items || [];
  } catch (error) {
    console.error(`❌ 블로그 검색 오류 [${keyword}]:`, error.message);
    return [];
  }
}

// 네이버 뉴스 검색
async function searchNaverNews(keyword) {
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { 
        query: keyword, 
        display: 100,
        sort: 'sim'
      },
      headers: { 
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET 
      }
    });
    return response.data.items || [];
  } catch (error) {
    console.error(`❌ 뉴스 검색 오류 [${keyword}]:`, error.message);
    return [];
  }
}

async function collectContent() {
  console.log('🚀 수집 시작...');
  const results = [];
  let targetCounts = {
    priority1: 5,  // 공모전+후기
    priority2: 5,  // 공모전만
    priority3: 5,  // 팀+참여+후기
    news: 5        // 뉴스
  };
  let actualCounts = {
    priority1: 0,
    priority2: 0,
    priority3: 0,
    news: 0
  };
  
  // ========== 블로그 수집 (우선순위별) ==========
  console.log('📌 블로그 수집 시작...');
  
  const blogItems = [];
  for (const keyword of PRIMARY_KEYWORDS) {
    console.log(`🔍 [블로그] ${keyword} 검색 중...`);
    const items = await searchNaverBlog(keyword);
    blogItems.push(...items);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`📊 총 ${blogItems.length}개 블로그 검색 완료`);
  console.log('🔍 필터링 중...');
  
  // 우선순위별로 분류
  const priority1 = [];
  const priority2 = [];
  const priority3 = [];
  
  for (const item of blogItems) {
    if (await isDuplicate(item.link)) continue;
    
    const title = stripHtml(item.title);
    const description = stripHtml(item.description);
    const filter = filterBlog(title, description);
    
    if (filter.pass) {
      const data = {
        item,
        title,
        description,
        filterReason: filter.reason
      };
      
      if (filter.priority === 1) priority1.push(data);
      else if (filter.priority === 2) priority2.push(data);
      else if (filter.priority === 3) priority3.push(data);
    }
  }
  
  console.log(`✅ 1순위(공모전+후기): ${priority1.length}개`);
  console.log(`✅ 2순위(공모전): ${priority2.length}개`);
  console.log(`✅ 3순위(팀+참여+후기): ${priority3.length}개`);
  
  // 1순위 처리
  console.log('\n📌 1순위 블로그 분석 중...');
  for (const data of priority1) {
    if (actualCounts.priority1 >= targetCounts.priority1) break;
    
    console.log(`  🤖 [1순위] ${data.title.substring(0, 30)}...`);
    const analysis = await analyzeWithClaude(data.title, data.description);
    
    if (!analysis) {
      console.log(`  ⏭️  AI 분석 실패 - 스킵`);
      continue;
    }
    
    results.push({
      source: 'blog',
      priority: 'priority1',
      keyword: data.filterReason,
      title: data.title,
      content: data.description,
      link: data.item.link,
      postDate: data.item.postdate,
      analysis,
      timestamp: new Date().toISOString()
    });
    
    actualCounts.priority1++;
    console.log(`  ✅ 추가 (${actualCounts.priority1}/${targetCounts.priority1})`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // 2순위 처리
  console.log('\n📌 2순위 블로그 분석 중...');
  for (const data of priority2) {
    if (actualCounts.priority2 >= targetCounts.priority2) break;
    
    console.log(`  🤖 [2순위] ${data.title.substring(0, 30)}...`);
    const analysis = await analyzeWithClaude(data.title, data.description);
    
    if (!analysis) {
      console.log(`  ⏭️  AI 분석 실패 - 스킵`);
      continue;
    }
    
    results.push({
      source: 'blog',
      priority: 'priority2',
      keyword: data.filterReason,
      title: data.title,
      content: data.description,
      link: data.item.link,
      postDate: data.item.postdate,
      analysis,
      timestamp: new Date().toISOString()
    });
    
    actualCounts.priority2++;
    console.log(`  ✅ 추가 (${actualCounts.priority2}/${targetCounts.priority2})`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // 3순위 처리
  console.log('\n📌 3순위 블로그 분석 중...');
  for (const data of priority3) {
    if (actualCounts.priority3 >= targetCounts.priority3) break;
    
    console.log(`  🤖 [3순위] ${data.title.substring(0, 30)}...`);
    const analysis = await analyzeWithClaude(data.title, data.description);
    
    if (!analysis) {
      console.log(`  ⏭️  AI 분석 실패 - 스킵`);
      continue;
    }
    
    results.push({
      source: 'blog',
      priority: 'priority3',
      keyword: data.filterReason,
      title: data.title,
      content: data.description,
      link: data.item.link,
      postDate: data.item.postdate,
      analysis,
      timestamp: new Date().toISOString()
    });
    
    actualCounts.priority3++;
    console.log(`  ✅ 추가 (${actualCounts.priority3}/${targetCounts.priority3})`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // ========== 뉴스 수집 ==========
  console.log('\n📌 뉴스 수집 시작...');
  
  const newsItems = [];
  for (const keyword of PRIMARY_KEYWORDS) {
    console.log(`📰 [뉴스] ${keyword} 검색 중...`);
    const items = await searchNaverNews(keyword);
    newsItems.push(...items);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`📊 총 ${newsItems.length}개 뉴스 검색 완료`);
  console.log('🔍 필터링 중...');
  
  const filteredNews = [];
  for (const item of newsItems) {
    if (await isDuplicate(item.link)) continue;
    
    const title = stripHtml(item.title);
    const description = stripHtml(item.description);
    const filter = filterNews(title, description);
    
    if (filter.pass) {
      filteredNews.push({
        item,
        title,
        description,
        entities: filter.entities,
        filterReason: filter.reason
      });
    }
  }
  
  console.log(`✅ 필터 통과 뉴스: ${filteredNews.length}개`);
  
  // 뉴스 처리
  console.log('\n📌 뉴스 분석 중...');
  for (const data of filteredNews) {
    if (actualCounts.news >= targetCounts.news) break;
    
    console.log(`  🤖 [뉴스] ${data.title.substring(0, 30)}...`);
    console.log(`      반복 단어: ${data.entities}`);
    const analysis = await analyzeWithClaude(data.title, data.description);
    
    if (!analysis) {
      console.log(`  ⏭️  AI 분석 실패 - 스킵`);
      continue;
    }
    
    results.push({
      source: 'news',
      priority: 'news',
      keyword: data.entities,
      title: data.title,
      content: data.description,
      link: data.item.link,
      postDate: data.item.postdate,
      analysis,
      timestamp: new Date().toISOString()
    });
    
    actualCounts.news++;
    console.log(`  ✅ 추가 (${actualCounts.news}/${targetCounts.news})`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('');
  console.log('✅ 수집 완료!');
  console.log(`📊 1순위 블로그: ${actualCounts.priority1}개`);
  console.log(`📊 2순위 블로그: ${actualCounts.priority2}개`);
  console.log(`📊 3순위 블로그: ${actualCounts.priority3}개`);
  console.log(`📊 뉴스: ${actualCounts.news}개`);
  console.log(`📊 총합: ${results.length}개`);
  
  return results;
}

async function saveToCases(items) {
  console.log('💾 데이터 저장 중...');
  
  let autoApproved = 0;
  let pendingReview = 0;
  
  for (const item of items) {
    const analysis = item.analysis;
    
    // 신뢰도 기반 자동 승인 판단
    const actorConfident = analysis.actor.confidence >= 80;
    const typeConfident = analysis.teamType.confidence >= 80;
    const isAutoApproved = actorConfident && typeConfident;
    
    // 검토 필요 여부
    let status = 'auto-approved';
    let needsReview = [];
    
    if (!actorConfident) {
      status = 'pending-actor';
      needsReview.push('actor');
    }
    if (!typeConfident) {
      status = 'pending-type';
      needsReview.push('type');
    }
    if (!actorConfident && !typeConfident) {
      status = 'pending-both';
    }
    
    // cases 컬렉션에 저장
    const caseData = {
      title: item.title,
      content: item.content,
      excerpt: analysis.excerpt,
      link: item.link,
      source: item.source,
      postDate: item.postDate,
      collectedAt: item.timestamp,
      keyword: item.keyword,
      priority: item.priority,
      
      actor: {
        label: analysis.actor.label,
        confidence: analysis.actor.confidence,
        options: analysis.actor.alternatives || []
      },
      
      teamType: {
        label: analysis.teamType.label,
        category: analysis.teamType.category,
        confidence: analysis.teamType.confidence,
        options: analysis.teamType.alternatives || []
      },
      
      primaryCategory: {
        label: analysis.primaryCategory.label,
        confidence: analysis.primaryCategory.confidence
      },
      
      secondaryCategory: null,
      
      classificationReason: {
        excerpt: analysis.excerpt,
        actorReason: analysis.reason.actorReason,
        typeReason: analysis.reason.typeReason,
        isPositive: analysis.reason.isPositive
      },
      
      status: status,
      needsReview: needsReview,
      reviewedAt: isAutoApproved ? item.timestamp : null
    };
    
    await db.collection('cases').add(caseData);
    
    if (isAutoApproved) {
      autoApproved++;
    } else {
      pendingReview++;
    }
    
    // 로그 저장
    await db.collection('logs').add({
      action: 'collection',
      caseTitle: item.title,
      status: status,
      timestamp: new Date().toISOString()
    });
  }
  
  console.log(`✅ 저장 완료!`);
  console.log(`   자동 승인: ${autoApproved}개`);
  console.log(`   검토 대기: ${pendingReview}개`);
}

async function main() {
  try {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('팀플레이 유형 데이터 수집기 v5.2');
    console.log('정교한 필터링 + Claude AI 분석');
    console.log('═══════════════════════════════════════');
    console.log(`시작: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
    console.log('');
    
    const items = await collectContent();
    
    if (items.length > 0) {
      await saveToCases(items);
      console.log('');
      console.log('🎉 작업 완료!');
    } else {
      console.log('⚠️ 새 항목 없음');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ 치명적 오류:', error);
    process.exit(1);
  }
}

main();
