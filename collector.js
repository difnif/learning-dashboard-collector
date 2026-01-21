const admin = require('firebase-admin');
const axios = require('axios');

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
db.settings({
  ignoreUndefinedProperties: true
});
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// 키워드 분류
const PRIMARY_KEYWORDS = [
  '공모전', '팀플', '팀프로젝트', '대회', '세미나', '조별과제', '협업'
];

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
}

async function isDuplicate(link) {
  const snapshot = await db.collection('cases').where('link', '==', link).limit(1).get();
  return !snapshot.empty;
}

// ========== 블로그 필터링 ==========
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
  
  // 고유명사 빈도 체크
  const words = text.match(/[가-힣]{2,4}/g) || [];
  const wordCount = {};
  
  words.forEach(word => {
    const commonWords = ['하는', '있는', '없는', '되는', '이를', '그는', '같은', '위한', '대한', '등의'];
    if (commonWords.includes(word)) return;
    
    wordCount[word] = (wordCount[word] || 0) + 1;
  });
  
  const repeated = Object.entries(wordCount).filter(([word, count]) => count >= 3);
  
  if (repeated.length > 0) {
    return { 
      pass: true, 
      entities: repeated.map(([word, count]) => `${word}(${count}회)`).join(', '),
      reason: '인물/기관명 반복'
    };
  }
  
  return { pass: false, reason: '반복 단어 부족' };
}

// ========== 키워드 기반 간단 분석 ==========
function simpleAnalyze(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  
  // 행위 주체 분류
  let actor = '기타';
  let actorConfidence = 50;
  
  if (text.includes('학생') || text.includes('대학') || text.includes('학교')) {
    actor = '학생';
    actorConfidence = 60;
  } else if (text.includes('직장') || text.includes('회사') || text.includes('업무')) {
    actor = '직장인';
    actorConfidence = 60;
  } else if (text.includes('정치') || text.includes('의원') || text.includes('국회')) {
    actor = '정치인';
    actorConfidence = 70;
  }
  
  // 팀플 유형 분류
  let teamType = '협력형';
  let teamCategory = '협업';
  let typeConfidence = 50;
  
  if (text.includes('주도') || text.includes('이끌') || text.includes('리더')) {
    teamType = '주도형';
    teamCategory = '리더십';
    typeConfidence = 60;
  } else if (text.includes('협업') || text.includes('협력') || text.includes('함께')) {
    teamType = '협력형';
    teamCategory = '협업';
    typeConfidence = 60;
  } else if (text.includes('소통') || text.includes('대화')) {
    teamType = '소통형';
    teamCategory = '소통';
    typeConfidence = 60;
  } else if (text.includes('창의') || text.includes('아이디어')) {
    teamType = '창의형';
    teamCategory = '혁신';
    typeConfidence = 60;
  }
  
  // 카테고리 분류
  let category = '기타';
  let categoryConfidence = 50;
  
  if (text.includes('교육') || text.includes('학교') || text.includes('대학')) {
    category = '교육';
    categoryConfidence = 70;
  } else if (text.includes('기술') || text.includes('개발') || text.includes('프로그램')) {
    category = '기술';
    categoryConfidence = 70;
  } else if (text.includes('정치') || text.includes('정부')) {
    category = '정치';
    categoryConfidence = 70;
  } else if (text.includes('경제') || text.includes('기업')) {
    category = '경제';
    categoryConfidence = 70;
  }
  
  // 발췌 (첫 100자)
  const excerpt = description.substring(0, 100) + '...';
  
  return {
    actor: {
      label: actor,
      confidence: actorConfidence,
      alternatives: []
    },
    teamType: {
      label: teamType,
      category: teamCategory,
      confidence: typeConfidence,
      alternatives: []
    },
    primaryCategory: {
      label: category,
      confidence: categoryConfidence
    },
    excerpt: excerpt,
    reason: {
      actorReason: '키워드 매칭',
      typeReason: '키워드 매칭',
      isPositive: true
    }
  };
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
    priority1: 15,  // 공모전+후기
    priority2: 15,  // 공모전만
    priority3: 10,  // 팀+참여+후기
    news: 10        // 뉴스
  };
  let actualCounts = {
    priority1: 0,
    priority2: 0,
    priority3: 0,
    news: 0
  };
  
  // ========== 블로그 수집 ==========
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
  
  // 우선순위별 분류
  const priority1 = [];
  const priority2 = [];
  const priority3 = [];
  
  for (const item of blogItems) {
    if (await isDuplicate(item.link)) continue;
    
    const title = stripHtml(item.title);
    const description = stripHtml(item.description);
    const filter = filterBlog(title, description);
    
    if (filter.pass) {
      const data = { item, title, description, filterReason: filter.reason };
      
      if (filter.priority === 1) priority1.push(data);
      else if (filter.priority === 2) priority2.push(data);
      else if (filter.priority === 3) priority3.push(data);
    }
  }
  
  console.log(`✅ 1순위(공모전+후기): ${priority1.length}개`);
  console.log(`✅ 2순위(공모전): ${priority2.length}개`);
  console.log(`✅ 3순위(팀+참여+후기): ${priority3.length}개`);
  
  // 1순위 처리
  console.log('\n📌 1순위 블로그 처리 중...');
  for (const data of priority1) {
    if (actualCounts.priority1 >= targetCounts.priority1) break;
    
    console.log(`  ✅ [1순위] ${data.title.substring(0, 40)}...`);
    const analysis = simpleAnalyze(data.title, data.description);
    
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
  }
  
  // 2순위 처리
  console.log('\n📌 2순위 블로그 처리 중...');
  for (const data of priority2) {
    if (actualCounts.priority2 >= targetCounts.priority2) break;
    
    console.log(`  ✅ [2순위] ${data.title.substring(0, 40)}...`);
    const analysis = simpleAnalyze(data.title, data.description);
    
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
  }
  
  // 3순위 처리
  console.log('\n📌 3순위 블로그 처리 중...');
  for (const data of priority3) {
    if (actualCounts.priority3 >= targetCounts.priority3) break;
    
    console.log(`  ✅ [3순위] ${data.title.substring(0, 40)}...`);
    const analysis = simpleAnalyze(data.title, data.description);
    
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
        entities: filter.entities
      });
    }
  }
  
  console.log(`✅ 필터 통과 뉴스: ${filteredNews.length}개`);
  
  // 뉴스 처리
  console.log('\n📌 뉴스 처리 중...');
  for (const data of filteredNews) {
    if (actualCounts.news >= targetCounts.news) break;
    
    console.log(`  ✅ [뉴스] ${data.title.substring(0, 40)}...`);
    console.log(`      반복: ${data.entities}`);
    const analysis = simpleAnalyze(data.title, data.description);
    
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
  
  for (const item of items) {
    const analysis = item.analysis;
    
    // 키워드 매칭이라 신뢰도 낮음 → 모두 검토 대기
    const status = 'pending-both';
    const needsReview = ['actor', 'type'];
    
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
        options: analysis.actor.alternatives
      },
      
      teamType: {
        label: analysis.teamType.label,
        category: analysis.teamType.category,
        confidence: analysis.teamType.confidence,
        options: analysis.teamType.alternatives
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
      reviewedAt: null
    };
    
    await db.collection('cases').add(caseData);
    
    // 로그 저장
    await db.collection('logs').add({
      action: 'collection',
      caseTitle: item.title,
      status: status,
      timestamp: new Date().toISOString()
    });
  }
  
  console.log(`✅ 저장 완료! ${items.length}개`);
  console.log(`   (모두 검토 대기 상태로 저장됨)`);
}

async function main() {
  try {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('팀플레이 유형 데이터 수집기 v6.0');
    console.log('키워드 필터링 버전 (AI 없음)');
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
