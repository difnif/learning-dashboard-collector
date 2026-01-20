const admin = require('firebase-admin');
const axios = require('axios');

// 1. Firebase 설정 및 초기화
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// 2. 검색 키워드 설정
const KEYWORDS = ['팀플', '팀프로젝트', '조별과제', '무임승차', '프리라이더', '조장', '조원', '역할분담', '협업', '팀워크'];

// 3. 콘텐츠 분류 로직 (메인/서브 카테고리)
function categorizeContent(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('무임승차') || text.includes('프리라이더')) return { main: '팀플', sub: '무임승차형' };
  if (text.includes('조장') || text.includes('리더')) return { main: '팀플', sub: '주도형' };
  if (text.includes('역할분담') || text.includes('계획')) return { main: '팀플', sub: '플래너형' };
  if (text.includes('협업') || text.includes('팀워크')) return { main: '팀플', sub: '협력형' };
  return { main: '팀플', sub: '기타' };
}

// 4. 세부 유형 분석 로직
function analyzeType(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const types = [];
  if (text.includes('무임승차') || text.includes('안 함') || text.includes('안함')) types.push({ type: '무임승차형', confidence: 85 });
  if (text.includes('혼자') || text.includes('다 했') || text.includes('다했')) types.push({ type: '과도헌신형', confidence: 75 });
  if (text.includes('계획') || text.includes('일정') || text.includes('플래너')) types.push({ type: '플래너형', confidence: 70 });
  if (text.includes('갈등') || text.includes('싸움') || text.includes('의견충돌')) types.push({ type: '갈등형', confidence: 80 });
  return types.length > 0 ? types : [{ type: '기타', confidence: 50 }];
}

// 5. 네이버 블로그 검색 API 호출
async function searchNaverBlog(keyword, display = 10) {
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
      params: { query: keyword, display: display, sort: 'date' },
      headers: { 
        'X-Naver-Client-Id': NAVER_CLIENT_ID, 
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET 
      }
    });
    return response.data.items || [];
  } catch (error) {
    console.error(`Blog search error for [${keyword}]:`, error.message);
    return [];
  }
}

// 6. 메인 실행 함수 (데이터 수집 및 저장)
async function collectAndSave() {
  console.log('🚀 데이터 수집 시작...');
  
  for (const keyword of KEYWORDS) {
    const items = await searchNaverBlog(keyword);
    
    for (const item of items) {
      const category = categorizeContent(item.title, item.description);
      const analysis = analyzeType(item.title, item.description);
      
      // Firestore 저장 데이터 구조화
      const postData = {
        title: item.title.replace(/<[^>]*>?
