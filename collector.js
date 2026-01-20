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
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// 키워드 분류
const PRIMARY_KEYWORDS = [
  '공모전', '팀플', '팀프로젝트', '대회', '세미나', '조별과제', '협업',
  '컬래버레이션', '콜라보', '워크샵', '해커톤', '프로젝트팀', '동아리', '학회'
];

const SECONDARY_KEYWORDS = [
  '무임승차', '프리라이더', '조장', '역할분담', '갈등',
  '단체', '연합', '연대', '총회', '노조', '회의', '소통', '의사결정', '책임전가'
];

// 제외할 일반 단어 (너무 흔함)
const EXCLUDED_WORDS = [
  '사람', '학생', '회사', '일', '오늘', '내일', '어제', '시간', '정말', '진짜',
  '이것', '그것', '저것', '여기', '거기', '저기', '이번', '다음', '지난',
  '우리', '제가', '나는', '당신', '그들', '이거', '그거', '요즘', '최근'
];

// 전역 변수: 키워드 빈도 추적
const keywordFrequency = new Map();

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
}

async function isDuplicate(link) {
  const snapshot = await db.collection('collected').where('link', '==', link).limit(1).get();
  return !snapshot.empty;
}

// 텍스트에서 키워드 후보 추출 및 빈도 카운트
function analyzeKeywords(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  
  // 간단한 명사 추출 (2-5글자 한글 단어)
  const words = text.match(/[가-힣]{2,5}/g) || [];
  
  for (const word of words) {
    // 기존 키워드거나 제외 단어면 스킵
    if ([...PRIMARY_KEYWORDS, ...SECONDARY_KEYWORDS, ...EXCLUDED_WORDS].some(k => k.includes(word) || word.includes(k))) {
      continue;
    }
    
    // 빈도수 증가
    keywordFrequency.set(word, (keywordFrequency.get(word) || 0) + 1);
  }
}

// 키워드 제안 생성
function generateKeywordSuggestions() {
  const suggestions = [];
  
  for (const [word, count] of keywordFrequency.entries()) {
    // 10회 이상 등장한 단어만 제안
    if (count >= 10) {
      suggestions.push({
        keyword: word,
        frequency: count
      });
    }
  }
  
  // 빈도순 정렬
  suggestions.sort((a, b) => b.frequency - a.frequency);
  
  return suggestions.slice(0, 5); // 상위 5개만
}

function categorizeContent(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  
  // 공모전/대회
  if (text.includes('공모전') || text.includes('대회') || text.includes('해커톤')) {
    return { main: '공모전/대회', sub: '팀 프로젝트' };
  }
  
  // 세미나/워크샵
  if (text.includes('세미나') || text.includes('워크샵') || text.includes('학회')) {
    return { main: '학습', sub: '세미나/워크샵' };
  }
  
  // 동아리/단체
  if (text.includes('동아리') || text.includes('단체') || text.includes('연합')) {
    return { main: '조직', sub: '동아리/단체' };
  }
  
  // 협업 프로젝트
  if (text.includes('콜라보') || text.includes('컬래버') || text.includes('협업')) {
    return { main: '협업', sub: '프로젝트' };
  }
  
  // 팀플 유형 세분화
  if (text.includes('무임승차') || text.includes('프리라이더')) {
    return { main: '팀플', sub: '무임승차형' };
  }
  if (text.includes('조장') || text.includes('리더')) {
    return { main: '팀플', sub: '주도형' };
  }
  if (text.includes('역할분담') || text.includes('계획')) {
    return { main: '팀플', sub: '플래너형' };
  }
  if (text.includes('갈등') || text.includes('싸움') || text.includes('의견충돌')) {
    return { main: '팀플', sub: '갈등형' };
  }
  if (text.includes('소통') || text.includes('회의') || text.includes('의사결정')) {
    return { main: '팀플', sub: '소통형' };
  }
  
  return { main: '팀플', sub: '일반' };
}

function analyzeType(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const types = [];
  
  if (text.includes('무임승차') || text.includes('안 함')) {
    types.push({ type: '무임승차형', confidence: 85 });
  }
  if (text.includes('혼자') || text.includes('다 했')) {
    types.push({ type: '과도헌신형', confidence: 80 });
  }
  if (text.includes('계획') || text.includes('플래너')) {
    types.push({ type: '플래너형', confidence: 70 });
  }
  if (text.includes('갈등') || text.includes('의견충돌')) {
    types.push({ type: '갈등형', confidence: 75 });
  }
  if (text.includes('리더') || text.includes('조장')) {
    types.push({ type: '주도형', confidence: 80 });
  }
  if (text.includes('소통') || text.includes('협업')) {
    types.push({ type: '협력형', confidence: 75 });
  }
  
  return types.length > 0 ? types : [{ type: '일반', confidence: 50 }];
}

async function searchNaverBlog(keyword, display = 10) {
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
      params: { query: keyword, display, sort: 'date' },
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

async function searchNaverNews(keyword, display = 5) {
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { query: keyword, display, sort: 'date' },
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
  let primaryBlogCount = 0;
  let secondaryBlogCount = 0;
  let primaryNewsCount = 0;
  let secondaryNewsCount = 0;
  
  // 빈도 카운터 초기화
  keywordFrequency.clear();
  
  // === 블로그 수집 ===
  
  // 1차 키워드 블로그 (목표: 55개)
  console.log('📌 1차 키워드 블로그 수집 (목표: 55개)');
  for (const keyword of PRIMARY_KEYWORDS) {
    if (primaryBlogCount >= 55) break;
    
    console.log(`🔍 [1차] ${keyword}`);
    const items = await searchNaverBlog(keyword, 10);
    
    for (const item of items) {
      if (primaryBlogCount >= 55) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      // 키워드 분석
      analyzeKeywords(title, description);
      
      results.push({
        source: 'blog',
        priority: 'primary',
        keyword,
        title,
        description,
        link: item.link,
        category: categorizeContent(title, description),
        types: analyzeType(title, description),
        timestamp: new Date().toISOString()
      });
      
      primaryBlogCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // 2차 키워드 블로그 (목표: 25개)
  console.log('📌 2차 키워드 블로그 수집 (목표: 25개)');
  for (const keyword of SECONDARY_KEYWORDS) {
    if (secondaryBlogCount >= 25) break;
    
    console.log(`🔍 [2차] ${keyword}`);
    const items = await searchNaverBlog(keyword, 8);
    
    for (const item of items) {
      if (secondaryBlogCount >= 25) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      // 키워드 분석
      analyzeKeywords(title, description);
      
      results.push({
        source: 'blog',
        priority: 'secondary',
        keyword,
        title,
        description,
        link: item.link,
        category: categorizeContent(title, description),
        types: analyzeType(title, description),
        timestamp: new Date().toISOString()
      });
      
      secondaryBlogCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // === 뉴스 수집 ===
  
  // 1차 키워드 뉴스 (목표: 15개)
  console.log('📌 1차 키워드 뉴스 수집 (목표: 15개)');
  for (const keyword of PRIMARY_KEYWORDS) {
    if (primaryNewsCount >= 15) break;
    
    console.log(`📰 [1차] ${keyword}`);
    const items = await searchNaverNews(keyword, 4);
    
    for (const item of items) {
      if (primaryNewsCount >= 15) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      // 키워드 분석
      analyzeKeywords(title, description);
      
      results.push({
        source: 'news',
        priority: 'primary',
        keyword,
        title,
        description,
        link: item.link,
        category: categorizeContent(title, description),
        types: analyzeType(title, description),
        timestamp: new Date().toISOString()
      });
      
      primaryNewsCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // 2차 키워드 뉴스 (목표: 5개)
  console.log('📌 2차 키워드 뉴스 수집 (목표: 5개)');
  for (const keyword of SECONDARY_KEYWORDS) {
    if (secondaryNewsCount >= 5) break;
    
    console.log(`📰 [2차] ${keyword}`);
    const items = await searchNaverNews(keyword, 2);
    
    for (const item of items) {
      if (secondaryNewsCount >= 5) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      // 키워드 분석
      analyzeKeywords(title, description);
      
      results.push({
        source: 'news',
        priority: 'secondary',
        keyword,
        title,
        description,
        link: item.link,
        category: categorizeContent(title, description),
        types: analyzeType(title, description),
        timestamp: new Date().toISOString()
      });
      
      secondaryNewsCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('');
  console.log('✅ 수집 완료!');
  console.log(`📊 블로그: ${primaryBlogCount + secondaryBlogCount}개 (1차: ${primaryBlogCount}, 2차: ${secondaryBlogCount})`);
  console.log(`📊 뉴스: ${primaryNewsCount + secondaryNewsCount}개 (1차: ${primaryNewsCount}, 2차: ${secondaryNewsCount})`);
  console.log(`📊 총합: ${results.length}개`);
  
  return results;
}

async function saveToUserDB(items) {
  console.log('💾 데이터 저장 중...');
  
  const usersSnapshot = await db.collection('users').get();
  if (usersSnapshot.empty) {
    console.log('⚠️ 사용자 없음');
    return;
  }
  
  // 키워드 제안 생성
  const keywordSuggestions = generateKeywordSuggestions();
  
  if (keywordSuggestions.length > 0) {
    console.log('');
    console.log('🔑 새 키워드 제안:');
    keywordSuggestions.forEach(s => {
      console.log(`   - "${s.keyword}" (${s.frequency}회 발견)`);
    });
  }
  
  for (const userDoc of usersSnapshot.docs) {
    const userData = userDoc.data();
    
    // 모호한 분류 항목
    const classificationApprovals = items
      .filter(item => item.types.length > 1)
      .map((item, index) => ({
        id: Date.now() + index,
        type: 'classification',
        title: '모호한 분류: 유형 결정',
        content: item.title,
        description: item.description.substring(0, 150) + '...',
        link: item.link,
        source: item.source,
        keyword: item.keyword,
        priority: item.priority,
        options: item.types.map(t => ({ label: t.type, percentage: t.confidence }))
      }));
    
    // 키워드 제안 항목
    const keywordApprovals = keywordSuggestions.map((suggestion, index) => ({
      id: Date.now() + 1000000 + index,
      type: 'keyword',
      title: '새 키워드 제안',
      content: `"${suggestion.keyword}" 키워드를 추가하시겠습니까?`,
      description: `이번 수집에서 ${suggestion.frequency}회 발견되었습니다.`,
      keyword: suggestion.keyword,
      frequency: suggestion.frequency,
      options: [
        { label: '1차 키워드로 추가', value: 'primary' },
        { label: '2차 키워드로 추가', value: 'secondary' },
        { label: '제외', value: 'exclude' }
      ]
    }));
    
    const allApprovals = [...classificationApprovals, ...keywordApprovals];
    const autoApproved = items.filter(item => item.types.length === 1);
    const currentStats = userData.stats || { total: 0, pending: 0, approved: 0, rejected: 0 };
    
    const blogCount = items.filter(i => i.source === 'blog').length;
    const newsCount = items.filter(i => i.source === 'news').length;
    const primaryCount = items.filter(i => i.priority === 'primary').length;
    const secondaryCount = items.filter(i => i.priority === 'secondary').length;
    
    await db.collection('users').doc(userDoc.id).update({
      stats: {
        total: currentStats.total + items.length,
        pending: currentStats.pending + allApprovals.length,
        approved: currentStats.approved + autoApproved.length,
        rejected: currentStats.rejected || 0
      },
      approvalQueue: [...(userData.approvalQueue || []), ...allApprovals],
      activities: [{
        time: '방금',
        action: '수집',
        content: `${items.length}개 수집 (블로그 ${blogCount}, 뉴스 ${newsCount}) [1차: ${primaryCount}, 2차: ${secondaryCount}]${keywordSuggestions.length > 0 ? ` + 키워드 ${keywordSuggestions.length}개 제안` : ''}`
      }, ...(userData.activities || [])].slice(0, 20),
      lastCollection: new Date().toISOString()
    });
    
    console.log(`✅ 사용자 ${userDoc.id} 업데이트 완료`);
  }
  
  // collected 컬렉션에 저장
  for (const item of items) {
    await db.collection('collected').add({ 
      ...item, 
      collectedAt: new Date().toISOString() 
    });
  }
  
  console.log('✅ 저장 완료!');
}

async function main() {
  try {
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('🎓 Learning Dashboard Collector v2.0');
    console.log('═══════════════════════════════════════');
    console.log(`시작: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
    console.log('');
    
    const items = await collectContent();
    
    if (items.length > 0) {
      await saveToUserDB(items);
      console.log('');
      console.log('🎉 작업 완료!');
    } else {
      console.log('⚠️ 새 항목 없음 (모두 중복)');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ 치명적 오류:', error);
    process.exit(1);
  }
}

main();
```

---

## ✨ 새로운 기능

### 1. 확장된 키워드
```
1차: 공모전, 팀플, 대회, 세미나, 콜라보, 워크샵, 해커톤, 동아리, 학회 등
2차: 무임승차, 갈등, 단체, 연합, 노조, 회의, 소통, 의사결정 등
```

### 2. 자동 키워드 제안 🆕
```
[새 키워드 제안] "스타트업" (15회 발견)
→ 1차 키워드로 추가
→ 2차 키워드로 추가
→ 제외
```

### 3. 향상된 카테고리
```
- 공모전/대회
- 학습 (세미나/워크샵)
- 조직 (동아리/단체)
- 협업 (프로젝트)
- 팀플 (여러 유형)
