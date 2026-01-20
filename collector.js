const admin = require('firebase-admin');
const axios = require('axios');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

const KEYWORDS = ['팀플', '팀프로젝트', '조별과제', '무임승차', '프리라이더', '조장', '조원', '역할분담', '협업', '팀워크'];

function categorizeContent(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('무임승차') || text.includes('프리라이더')) return { main: '팀플', sub: '무임승차형' };
  if (text.includes('조장') || text.includes('리더')) return { main: '팀플', sub: '주도형' };
  if (text.includes('역할분담') || text.includes('계획')) return { main: '팀플', sub: '플래너형' };
  if (text.includes('협업') || text.includes('팀워크')) return { main: '팀플', sub: '협력형' };
  return { main: '팀플', sub: '기타' };
}

function analyzeType(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const types = [];
  if (text.includes('무임승차') || text.includes('안 함') || text.includes('안함')) types.push({ type: '무임승차형', confidence: 85 });
  if (text.includes('혼자') || text.includes('다 했') || text.includes('다했')) types.push({ type: '과도헌신형', confidence: 75 });
  if (text.includes('계획') || text.includes('일정') || text.includes('플래너')) types.push({ type: '플래너형', confidence: 70 });
  if (text.includes('갈등') || text.includes('싸움') || text.includes('의견충돌')) types.push({ type: '갈등형', confidence: 80 });
  return types.length > 0 ? types : [{ type: '기타', confidence: 50 }];
}

async function searchNaverBlog(keyword, display = 10) {
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/blog.json', {
      params: { query: keyword, display: display, sort: 'date' },
      headers: { 'X-Naver-Client-Id': NAVER_CLIENT_ID, 'X-Naver-Client-Secret': NAVER_CLIENT_SECRET }
    });
    return response.data.items || [];
  } catch (error) {
    console.error('Blog search error:', error.messag
