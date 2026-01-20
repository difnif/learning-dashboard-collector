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

// 제외할 일반 단어
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

// 1차 카테고리 분석 (주제 12개)
function analyzePrimaryCategory(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const categories = [];
  
  // 정치
  const politicsKeywords = ['정치', '국회', '의원', '선거', '법안', '정당', '정부', '대통령'];
  if (politicsKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '정치', 
      confidence: 90,
      keywords: politicsKeywords.filter(k => text.includes(k))
    });
  }
  
  // 사회
  const societyKeywords = ['사회', '복지', '시민', '주민', '지역', '공동체'];
  if (societyKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '사회', 
      confidence: 85,
      keywords: societyKeywords.filter(k => text.includes(k))
    });
  }
  
  // 경제
  const economyKeywords = ['경제', '금융', '무역', '투자', '기업', '산업', '노동', '일자리'];
  if (economyKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '경제', 
      confidence: 85,
      keywords: economyKeywords.filter(k => text.includes(k))
    });
  }
  
  // 과학
  const scienceKeywords = ['과학', '연구', '실험', '논문', '발견', '이론'];
  if (scienceKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '과학', 
      confidence: 85,
      keywords: scienceKeywords.filter(k => text.includes(k))
    });
  }
  
  // 공학
  const engineeringKeywords = ['공학', '엔지니어', '설계', '제작', '기술개발'];
  if (engineeringKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '공학', 
      confidence: 85,
      keywords: engineeringKeywords.filter(k => text.includes(k))
    });
  }
  
  // 의료
  const medicalKeywords = ['의료', '병원', '의사', '환자', '치료', '건강', '질병'];
  if (medicalKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '의료', 
      confidence: 85,
      keywords: medicalKeywords.filter(k => text.includes(k))
    });
  }
  
  // 교육
  const educationKeywords = ['교육', '학교', '대학', '학생', '교수', '수업', '강의', '팀플', '조별과제'];
  if (educationKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '교육', 
      confidence: 85,
      keywords: educationKeywords.filter(k => text.includes(k))
    });
  }
  
  // 문화
  const cultureKeywords = ['문화', '예술', '음악', '영화', '공연', '전시', '축제'];
  if (cultureKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '문화', 
      confidence: 85,
      keywords: cultureKeywords.filter(k => text.includes(k))
    });
  }
  
  // 스포츠
  const sportsKeywords = ['스포츠', '경기', '선수', '팀', '대회', '올림픽', '월드컵'];
  if (sportsKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '스포츠', 
      confidence: 85,
      keywords: sportsKeywords.filter(k => text.includes(k))
    });
  }
  
  // 환경
  const environmentKeywords = ['환경', '기후', '탄소', '에너지', '오염', '재생'];
  if (environmentKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '환경', 
      confidence: 85,
      keywords: environmentKeywords.filter(k => text.includes(k))
    });
  }
  
  // 기술
  const techKeywords = ['기술', 'IT', '소프트웨어', '앱', '프로그램', '코딩', '개발', '프로젝트'];
  if (techKeywords.some(k => text.includes(k))) {
    categories.push({ 
      label: '기술', 
      confidence: 85,
      keywords: techKeywords.filter(k => text.includes(k))
    });
  }
  
  // 기타 (아무것도 해당 안 되면)
  if (categories.length === 0) {
    categories.push({ 
      label: '기타', 
      confidence: 50,
      keywords: []
    });
  }
  
  return categories;
}

// 행위 주체 분석
function analyzeSubject(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const subjects = [];
  
  // 학생
  const studentKeywords = ['학생', '대학', '팀플', '조별과제', '학회'];
  if (studentKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '학생', 
      confidence: 85,
      keywords: studentKeywords.filter(k => text.includes(k))
    });
  }
  
  // 직장인
  const workerKeywords = ['회사', '직장', '프로젝트', '업무', '팀원', '부서'];
  if (workerKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '직장인', 
      confidence: 80,
      keywords: workerKeywords.filter(k => text.includes(k))
    });
  }
  
  // 정치인
  const politicianKeywords = ['국회', '의원', '정당', '법안', '정치'];
  if (politicianKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '정치인', 
      confidence: 90,
      keywords: politicianKeywords.filter(k => text.includes(k))
    });
  }
  
  // 블로거/크리에이터
  const creatorKeywords = ['블로그', '유튜브', '콘텐츠', '인플루언서', '크리에이터'];
  if (creatorKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '크리에이터', 
      confidence: 85,
      keywords: creatorKeywords.filter(k => text.includes(k))
    });
  }
  
  // 활동가
  const activistKeywords = ['시민단체', '활동가', '운동', '캠페인', '연대'];
  if (activistKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '활동가', 
      confidence: 80,
      keywords: activistKeywords.filter(k => text.includes(k))
    });
  }
  
  // 기업/단체
  const organizationKeywords = ['기업', '조직', '협회', '단체'];
  if (organizationKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '기업/단체', 
      confidence: 75,
      keywords: organizationKeywords.filter(k => text.includes(k))
    });
  }
  
  // 개발자
  const developerKeywords = ['개발', '코딩', '프로그래밍', '오픈소스', '깃허브'];
  if (developerKeywords.some(k => text.includes(k))) {
    subjects.push({ 
      label: '개발자', 
      confidence: 85,
      keywords: developerKeywords.filter(k => text.includes(k))
    });
  }
  
  return subjects.length > 0 ? subjects : [{ label: '기타', confidence: 50, keywords: [] }];
}

// 긍정적 유형 분석 (16개)
function analyzePositiveType(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const types = [];
  
  // 문제 상황 감지 (학습용)
  const problems = [];
  if (text.match(/무임승차|안 함|프리라이더/)) problems.push('무임승차');
  if (text.match(/독단|독선|혼자 결정/)) problems.push('독단');
  if (text.match(/갈등|싸움|의견충돌/)) problems.push('갈등');
  
  // === 리더십 계열 ===
  
  // 주도형
  const leaderKeywords = ['앞장', '이끌', '주도', '리더', '책임지고'];
  if (leaderKeywords.some(k => text.includes(k))) {
    types.push({
      type: '주도형',
      category: '리더십',
      confidence: 85,
      keywords: leaderKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 비전제시형
  const visionKeywords = ['방향', '목표', '비전', '제시', '방향성'];
  if (visionKeywords.some(k => text.includes(k))) {
    types.push({
      type: '비전제시형',
      category: '리더십',
      confidence: 80,
      keywords: visionKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 전략가형
  const strategyKeywords = ['계획', '전략', '플랜', '기획', '설계'];
  if (strategyKeywords.some(k => text.includes(k))) {
    types.push({
      type: '전략가형',
      category: '리더십',
      confidence: 85,
      keywords: strategyKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // === 실행 계열 ===
  
  // 실행형
  const executionKeywords = ['실행', '행동', '바로', '즉시', '실천'];
  if (executionKeywords.some(k => text.includes(k))) {
    types.push({
      type: '실행형',
      category: '실행',
      confidence: 85,
      keywords: executionKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 완수형
  const completionKeywords = ['완수', '끝까지', '마무리', '완성', '책임'];
  if (completionKeywords.some(k => text.includes(k))) {
    types.push({
      type: '완수형',
      category: '실행',
      confidence: 80,
      keywords: completionKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 속도형
  const speedKeywords = ['빠르게', '신속', '효율', '빨리', '재빠르'];
  if (speedKeywords.some(k => text.includes(k))) {
    types.push({
      type: '속도형',
      category: '실행',
      confidence: 75,
      keywords: speedKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // === 협업 계열 ===
  
  // 협력형
  const cooperationKeywords = ['협력', '함께', '같이', '협업', '공동'];
  if (cooperationKeywords.some(k => text.includes(k))) {
    types.push({
      type: '협력형',
      category: '협업',
      confidence: 85,
      keywords: cooperationKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 조율자형
  const coordinatorKeywords = ['조율', '조정', '균형', '맞추'];
  if (coordinatorKeywords.some(k => text.includes(k))) {
    types.push({
      type: '조율자형',
      category: '협업',
      confidence: 80,
      keywords: coordinatorKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 지원형
  const supportKeywords = ['지원', '돕', '서포트', '보조', '도움'];
  if (supportKeywords.some(k => text.includes(k))) {
    types.push({
      type: '지원형',
      category: '협업',
      confidence: 80,
      keywords: supportKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // === 소통 계열 ===
  
  // 소통형
  const communicationKeywords = ['소통', '대화', '이야기', '얘기'];
  if (communicationKeywords.some(k => text.includes(k))) {
    types.push({
      type: '소통형',
      category: '소통',
      confidence: 85,
      keywords: communicationKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 경청형
  const listeningKeywords = ['경청', '듣', '귀 기울', '들어줬'];
  if (listeningKeywords.some(k => text.includes(k))) {
    types.push({
      type: '경청형',
      category: '소통',
      confidence: 80,
      keywords: listeningKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 중재형
  const mediationKeywords = ['중재', '해결', '풀어', '조정', '타협'];
  if (mediationKeywords.some(k => text.includes(k))) {
    types.push({
      type: '중재형',
      category: '소통',
      confidence: 85,
      keywords: mediationKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // === 혁신 계열 ===
  
  // 혁신형
  const innovationKeywords = ['혁신', '새로운', '변화', '개선'];
  if (innovationKeywords.some(k => text.includes(k))) {
    types.push({
      type: '혁신형',
      category: '혁신',
      confidence: 80,
      keywords: innovationKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 창의형
  const creativeKeywords = ['창의', '아이디어', '발상', '독창적'];
  if (creativeKeywords.some(k => text.includes(k))) {
    types.push({
      type: '창의형',
      category: '혁신',
      confidence: 80,
      keywords: creativeKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // 분석형
  const analyticalKeywords = ['분석', '논리', '체계', '정리', '파악'];
  if (analyticalKeywords.some(k => text.includes(k))) {
    types.push({
      type: '분석형',
      category: '혁신',
      confidence: 80,
      keywords: analyticalKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  // === 안정 계열 ===
  
  // 신뢰구축형
  const trustKeywords = ['신뢰', '믿음', '약속', '성실', '진실'];
  if (trustKeywords.some(k => text.includes(k))) {
    types.push({
      type: '신뢰구축형',
      category: '안정',
      confidence: 80,
      keywords: trustKeywords.filter(k => text.includes(k)),
      problems
    });
  }
  
  return types.length > 0 ? types : [{ type: '일반', category: '기타', confidence: 50, keywords: [], problems }];
}

// 최적화된 블로그 검색
async function searchNaverBlog(keyword) {
  try {
    const randomStart = Math.floor(Math.random() * 10) * 100 + 1;
    const randomSort = Math.random() > 0.5 ? 'date' : 'sim';
    
    console.log(`   → start: ${randomStart}, sort: ${randomSort}`);
    
    const response = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
      params: { 
        query: keyword, 
        display: 100,
        start: randomStart,
        sort: randomSort
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

// 최적화된 뉴스 검색
async function searchNaverNews(keyword) {
  try {
    const randomStart = Math.floor(Math.random() * 10) * 100 + 1;
    const randomSort = Math.random() > 0.5 ? 'date' : 'sim';
    
    console.log(`   → start: ${randomStart}, sort: ${randomSort}`);
    
    const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { 
        query: keyword, 
        display: 100,
        start: randomStart,
        sort: randomSort
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
  let primaryBlogCount = 0;
  let secondaryBlogCount = 0;
  let primaryNewsCount = 0;
  let secondaryNewsCount = 0;
  
  keywordFrequency.clear();
  
  // 1차 키워드 블로그
  console.log('📌 1차 키워드 블로그 수집 (목표: 55개)');
  for (const keyword of PRIMARY_KEYWORDS) {
    if (primaryBlogCount >= 55) break;
    
    console.log(`🔍 [1차 블로그] ${keyword}`);
    const items = await searchNaverBlog(keyword);
    
    for (const item of items) {
      if (primaryBlogCount >= 55) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      analyzeKeywords(title, description);
      
      const primaryCategories = analyzePrimaryCategory(title, description);
      const subjects = analyzeSubject(title, description);
      const types = analyzePositiveType(title, description);
      
      results.push({
        source: 'blog',
        priority: 'primary',
        keyword,
        title,
        description,
        link: item.link,
        postDate: item.postdate,
        primaryCategories,
        subjects,
        types,
        timestamp: new Date().toISOString()
      });
      
      primaryBlogCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // 2차 키워드 블로그
  console.log('📌 2차 키워드 블로그 수집 (목표: 25개)');
  for (const keyword of SECONDARY_KEYWORDS) {
    if (secondaryBlogCount >= 25) break;
    
    console.log(`🔍 [2차 블로그] ${keyword}`);
    const items = await searchNaverBlog(keyword);
    
    for (const item of items) {
      if (secondaryBlogCount >= 25) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      analyzeKeywords(title, description);
      
      const primaryCategories = analyzePrimaryCategory(title, description);
      const subjects = analyzeSubject(title, description);
      const types = analyzePositiveType(title, description);
      
      results.push({
        source: 'blog',
        priority: 'secondary',
        keyword,
        title,
        description,
        link: item.link,
        postDate: item.postdate,
        primaryCategories,
        subjects,
        types,
        timestamp: new Date().toISOString()
      });
      
      secondaryBlogCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // 1차 키워드 뉴스
  console.log('📌 1차 키워드 뉴스 수집 (목표: 15개)');
  for (const keyword of PRIMARY_KEYWORDS) {
    if (primaryNewsCount >= 15) break;
    
    console.log(`📰 [1차 뉴스] ${keyword}`);
    const items = await searchNaverNews(keyword);
    
    for (const item of items) {
      if (primaryNewsCount >= 15) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      analyzeKeywords(title, description);
      
      const primaryCategories = analyzePrimaryCategory(title, description);
      const subjects = analyzeSubject(title, description);
      const types = analyzePositiveType(title, description);
      
      results.push({
        source: 'news',
        priority: 'primary',
        keyword,
        title,
        description,
        link: item.link,
        postDate: item.postdate,
        primaryCategories,
        subjects,
        types,
        timestamp: new Date().toISOString()
      });
      
      primaryNewsCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // 2차 키워드 뉴스
  console.log('📌 2차 키워드 뉴스 수집 (목표: 5개)');
  for (const keyword of SECONDARY_KEYWORDS) {
    if (secondaryNewsCount >= 5) break;
    
    console.log(`📰 [2차 뉴스] ${keyword}`);
    const items = await searchNaverNews(keyword);
    
    for (const item of items) {
      if (secondaryNewsCount >= 5) break;
      if (await isDuplicate(item.link)) continue;
      
      const title = stripHtml(item.title);
      const description = stripHtml(item.description);
      
      analyzeKeywords(title, description);
      
      const primaryCategories = analyzePrimaryCategory(title, description);
      const subjects = analyzeSubject(title, description);
      const types = analyzePositiveType(title, description);
      
      results.push({
        source: 'news',
        priority: 'secondary',
        keyword,
        title,
        description,
        link: item.link,
        postDate: item.postdate,
        primaryCategories,
        subjects,
        types,
        timestamp: new Date().toISOString()
      });
      
      secondaryNewsCount++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('');
  console.log('✅ 수집 완료!');
  console.log(`📊 블로그: ${primaryBlogCount + secondaryBlogCount}개`);
  console.log(`📊 뉴스: ${primaryNewsCount + secondaryNewsCount}개`);
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
    
    // 복잡한 케이스 (주체 2개 이상 OR 유형 2개 이상)
    const complexCases = items
      .filter(item => item.subjects.length > 1 || item.types.length > 1)
      .map((item, index) => ({
        id: Date.now() + index,
        type: 'classification',
        title: item.title,
        content: item.description.substring(0, 150) + '...',
        link: item.link,
        source: item.source,
        postDate: item.postDate,
        keyword: item.keyword,
        priority: item.priority,
        subjectOptions: item.subjects,
        typeOptions: item.types,
        primaryCategories: item.primaryCategories
      }));
    
    // 키워드 제안
    const keywordApprovals = keywordSuggestions.map((suggestion, index) => ({
      id: Date.now() + 1000000 + index,
      type: 'keyword',
      title: '새 키워드 제안',
      content: `"${suggestion.keyword}" 키워드를 추가하시겠습니까?`,
      description: `이번 수집에서 ${suggestion.frequency}회 발견되었습니다.`,
      keyword: suggestion.keyword,
      frequency: suggestion.frequency
    }));
    
    // 자동 승인 (주체 1개 AND 유형 1개)
    const autoApproved = items
      .filter(item => item.subjects.length === 1 && item.types.length === 1)
      .map(item => ({
        title: item.title,
        content: item.description,
        link: item.link,
        source: item.source,
        postDate: item.postDate,
        keyword: item.keyword,
        priority: item.priority,
        selectedSubject: item.subjects[0].label,
        selectedType: item.types[0].type,
        primaryCategory: item.primaryCategories[0]?.label || '기타',
        secondaryCategory: null,
        classificationReason: {
          primaryKeywords: item.primaryCategories[0]?.keywords || [],
          subjectKeywords: item.subjects[0].keywords,
          typeKeywords: item.types[0].keywords,
          problems: item.types[0].problems || [],
          confidence: item.types[0].confidence
        },
        decidedAt: new Date().toISOString()
      }));
    
    const allApprovals = [...complexCases, ...keywordApprovals];
    const currentStats = userData.stats || { total: 0, pending: 0, approved: 0, rejected: 0 };
    const currentApprovedItems = userData.approvedItems || [];
    const newApprovedItems = [...autoApproved, ...currentApprovedItems];
    
    await db.collection('users').doc(userDoc.id).update({
      stats: {
        total: currentStats.total + items.length,
        pending: currentStats.pending + allApprovals.length,
        approved: currentStats.approved + autoApproved.length,
        rejected: currentStats.rejected || 0
      },
      approvalQueue: [...(userData.approvalQueue || []), ...allApprovals],
      approvedItems: newApprovedItems,
      rejectedItems: userData.rejectedItems || []
    });
    
    console.log(`✅ 사용자 ${userDoc.id} 업데이트 완료`);
  }
  
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
    console.log('팀플레이 유형 데이터 수집기 v4.0');
    console.log('긍정적 유형 16개 + 주제 카테고리 12개');
    console.log('═══════════════════════════════════════');
    console.log(`시작: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
    console.log('');
    
    const items = await collectContent();
    
    if (items.length > 0) {
      await saveToUserDB(items);
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
