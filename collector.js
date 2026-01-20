const admin = require('firebase-admin');
const axios = require('axios');

// 1. 환경 변수 체크 및 Firebase 초기화
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('환경변수 FIREBASE_SERVICE_ACCOUNT가 설정되지 않았습니다.');
  }
  
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase 연결 성공');
} catch (error) {
  console.error('❌ Firebase 초기화 실패:', error.message);
  process.exit(1); // 초기화 실패 시 즉시 종료
}

const db = admin.firestore();
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// 네이버 API 키 확인
if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error('❌ 네이버 API 키가 누락되었습니다.');
  process.exit(1);
}

const KEYWORDS = ['팀플', '팀프로젝트', '조별과제', '무임승차', '프리라이더'];

function categorizeContent(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('무임승차') || text.includes('프리라이더')) return { main: '팀플', sub: '무임승차형' };
  return { main: '팀플', sub: '기타' };
}

function analyzeType(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('무임승차')) return [{ type: '무임승차형', confidence: 85 }];
  return [{ type: '기타', confidence: 50 }];
}

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
    console.error(`❌ 네이버 검색 오류 [${keyword}]:`, error.response ? error.response.status : error.message);
    return [];
  }
}

async function collectAndSave() {
  console.log('🚀 데이터 수집 시작...');
  try {
    for (const keyword of KEYWORDS) {
      const items = await searchNaverBlog(keyword);
      console.log(`🔍 [${keyword}] 검색 결과: ${items.length}건`);
      
      for (const item of items) {
        const category = categorizeContent(item.title, item.description);
        const analysis = analyzeType(item.title, item.description);
        
        const postData = {
          title: item.title.replace(/<[^>]*>?/gm, ''),
          link: item.link,
          description: item.description.replace(/<[^>]*>?/gm, ''),
          bloggername: item.bloggername,
          postdate: item.postdate,
          category: category,
          analysis: analysis,
          collectedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docId = Buffer.from(item.link).toString('base64').substring(0, 50);
        await db.collection('posts').doc(docId).set(postData, { merge: true });
      }
    }
    console.log('✨ 모든 작업 완료!');
  } catch (error) {
    console.error('❌ 실행 중 에러 발생:', error);
  }
}

collectAndSave();
