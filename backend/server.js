const express = require('express');
const session = require('express-session');
const passport = require('passport');
const cors = require('cors');
const path = require('path');

// ดึงโมดูลทั้งหมดมาเตรียมใช้งาน
const videoarRoutes = require('./routes/videoar');
const mapRoutes = require('./routes/map');
const tripRouter = require('./routes/trip');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/report');
const logsRoutes = require('./routes/logs');
const recommendationRouter = require('./routes/recommend');
const bannerRoutes = require('./routes/banners');
const editRoutes = require('./routes/edit');
const authRoutes = require('./routes/auth');
const contentRoutes = require('./routes/content');
const reviewRoutes = require('./routes/reviews');

const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET || 'sentang-huabaan-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// เปิดการเชื่อมต่อข้ามโดเมนข้ามพอร์ต
app.use(cors({
  origin: ['https://sentanghuabaan.com'],
  credentials: true
}));
app.use(express.json());

// EXPRESS STATIC ASSETS (การจัดเส้นทางเปิดแฟ้มแจกจ่ายรูปภาพและหน้าเว็บ)

app.use('/uploads', express.static(path.join(__dirname, 'pic_map')));
app.use('/upload', express.static(path.join(__dirname, 'upload')));
app.use('/picture', express.static(path.join(__dirname, 'picture')));

app.use('/backend', express.static(path.join(__dirname, 'backend')));
app.use('/backend/picture', express.static(path.join(__dirname, 'picture')));
app.use('/backend/pic_map', express.static(path.join(__dirname, 'pic_map')));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// BACKEND API ENDPOINTS MAPPING (ผูกจับพาร์ทเส้นทางส่งต่อไปเราเตอร์ย่อย)

app.use('/api', authRoutes);
app.use('/api', contentRoutes);
app.use('/api', reviewRoutes);
app.use('/api/videoar', videoarRoutes);
app.use('/api/map', mapRoutes);
app.use('/api', tripRouter);
app.use('/api/trips', tripRouter);
app.use('/api', dashboardRoutes);
app.use('/api', reportRoutes);
app.use('/api', logsRoutes);
app.use('/api', recommendationRouter);
app.use('/api', bannerRoutes);
app.use('/api', editRoutes);

// เส้นทางสำหรับเรนเดอร์เรียกแผงบริหารแอดมินเพจเบื้องต้น
app.get('/manage-system', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/admin_user.html'));
});


// ผูกพอร์ตให้แปรผันตามพอร์ตสากลที่เซิร์ฟเวอร์ Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 เส้นทางหัวบ้านเซิร์ฟเวอร์เปิดออนแอร์จริงแล้วบน Port: ${PORT}`);
});