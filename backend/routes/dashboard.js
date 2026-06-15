const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูลสถิติแดชบอร์ด
const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: "Access Denied: No Token Provided" });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ message: "Invalid or Expired Token" });
        }
        if (decoded.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden: You are not an Admin" });
        }
        req.admin = decoded;
        next();
    });
};

// สถิติภาพรวมตัวเลขสรุป (แนวทางที่ 1: แยกตารางที่มีมิติเวลาและไม่มีมิติเวลา)
router.get('/dashboard-stats', verifyAdminToken, (req, res) => {
    const { startDate, endDate } = req.query;
    let queryParams = [];
    
    let tripCondition = "";
    let reviewCondition = "";
    
    // กรองวันที่เฉพาะตารางที่มีมิติเวลาจริงเท่านั้น
    if (startDate && endDate) {
        tripCondition = " AND created_at BETWEEN ? AND ? ";
        reviewCondition = " AND created_at BETWEEN ? AND ? ";
        queryParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`); 
        queryParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`); 
    }

    // กลุ่มข้อมูลสะสมเสถียร (ไม่มีมิติเวลา หรือไม่เหมาะสมที่จะลดจำนวนตามตัวกรอง)
    const q1 = "SELECT COUNT(*) as total FROM User";
    const q2 = "SELECT COUNT(*) as total FROM Location WHERE is_deleted = 0";
    const q3 = "SELECT COUNT(*) as total FROM Activity WHERE is_deleted = 0";
    
    // กลุ่มข้อมูล Transaction ผันแปรตามช่วงเวลาจริง
    const q4 = `SELECT COUNT(*) as total FROM Trip WHERE is_deleted = 0 ${tripCondition}`;
    const q5 = `SELECT COUNT(*) as total FROM Review WHERE is_deleted = 0 ${reviewCondition}`;
    
    const q6 = "SELECT SUM(view_count) as total_views FROM VideoAR WHERE is_deleted = 0";
    const q7 = "SELECT COUNT(*) as total FROM Banners WHERE status = 'pending'";
    const q8 = "SELECT COUNT(*) as total FROM User WHERE status = 'banned'";

    db.query(`${q1}; ${q2}; ${q3}; ${q4}; ${q5}; ${q6}; ${q7}; ${q8}`, queryParams, (err, results) => {
        if (err) {
            console.error("Dashboard Stats Error:", err);
            return res.status(500).json({ error: err.message });
        }

        res.json({
            users: results[0][0].total,
            locations: results[1][0].total,
            activities: results[2][0].total,
            trips: results[3][0].total,      // จะผันแปรตามวันที่เลือก
            reviews: results[4][0].total,    // จะผันแปรตามวันที่เลือก
            ar_views: results[5][0].total_views || 0,
            pending_ads: results[6][0].total,
            banned_users: results[7][0].total
        });
    });
});

// ยอดสถิติผู้เข้าชมรายเดือน (กรองเงื่อนไขเวลาเข้า PageViews ได้แม่นยำ)
router.get('/monthly-visitors', verifyAdminToken, (req, res) => {
    const { startDate, endDate } = req.query;
    let sql = `SELECT MONTH(view_date) as month, COUNT(*) as count FROM PageViews WHERE 1=1 `;
    let queryParams = [];

    if (startDate && endDate) {
        sql += ` AND view_date BETWEEN ? AND ? `;
        queryParams.push(startDate, endDate);
    } else {
        sql += ` AND YEAR(view_date) = YEAR(CURRENT_DATE) `;
    }

    sql += ` GROUP BY MONTH(view_date) ORDER BY month ASC`;

    db.query(sql, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        const monthlyData = Array(12).fill(0);
        results.forEach(row => {
            monthlyData[row.month - 1] = row.count;
        });

        res.json({
            labels: ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'],
            values: monthlyData
        });
    });
});

// API สำหรับบันทึกการเข้าชม
router.post('/record-view', (req, res) => {
    const sql = "INSERT INTO PageViews (view_date) VALUES (CURRENT_DATE)";
    db.query(sql, (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "View recorded" });
    });
});

// อันดับสถานที่ยอดนิยม (แก้ไขโครงสร้างการวางตระกูล WHERE / JOIN ให้ทำงานได้แม้ไม่มีข้อมูลรีวิวในช่วงเวลานั้น)
router.get('/popular-locations', verifyAdminToken, (req, res) => {
    let category = req.query.category ? decodeURIComponent(req.query.category).trim() : 'all';
    const { startDate, endDate } = req.query;

    let sql = `
        SELECT 
            l.location_name,
            l.location_type,
            COUNT(r.review_id) as review_count
        FROM Location l
        LEFT JOIN Review r 
            ON l.location_id = r.location_id
            AND r.is_deleted = 0
    `;
    
    let queryParams = [];

    if (startDate && endDate) {
        sql += ` AND r.created_at BETWEEN ? AND ? `;
        queryParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
    }

    sql += ` WHERE l.is_deleted = 0 `;

    if (category && category !== 'all' && category !== 'undefined') {
        sql += ` AND LOWER(l.location_type) LIKE LOWER(?) `;
        queryParams.push(`%${category}%`);
    }

    sql += `
        GROUP BY l.location_id
        ORDER BY review_count DESC, l.location_name ASC
        LIMIT 5
    `;

    db.query(sql, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            labels: results.map(r => r.location_name),
            values: results.map(r => r.review_count)
        });
    });
});

// สถิตินับจำนวนขยะรวมตกค้าง
router.get('/trash-count', verifyAdminToken, (req, res) => {
    const tables = [
        'Location', 'Location_Images', 'Activity', 'Activity_Images',
        'History', 'History_Gallery', 'VideoAR', 'Community_Gallery',
        'Review', 'Map', 'Travel_Route', 'Trip', 'Trip_Detail'
    ];

    const queries = tables.map(table => `SELECT COUNT(*) as total FROM ${table} WHERE is_deleted = 1`).join('; ');

    db.query(queries, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        let totalTrash = 0;
        if (Array.isArray(results)) {
            results.forEach(result => {
                if (result && result[0]) totalTrash += result[0].total;
            });
        }
        res.json({ total: totalTrash });
    });
});

// ดึงสถิติ AR Engagement แยกตามหมวดหมู่สถานที่ (คงเดิมเนื่องจากเก็บยอด View_count สะสม)
router.get('/ar-engagement', verifyAdminToken, (req, res) => {
    let category = req.query.category ? decodeURIComponent(req.query.category).trim() : 'all';
    let categoryCondition = "";
    let queryParams = [];

    if (category && category !== 'all' && category !== 'undefined' && category !== '') {
        categoryCondition = "AND l.location_type LIKE ?";
        queryParams.push(`%${category}%`);
    }

    const sql = `
        SELECT l.location_name AS location_name, SUM(v.view_count) as total_views
        FROM VideoAR v
        JOIN Location l ON v.location_id = l.location_id
        WHERE v.is_deleted = 0 ${categoryCondition}
        GROUP BY l.location_id, l.location_name
        ORDER BY total_views DESC
    `;

    db.query(sql, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            labels: Array.isArray(results) ? results.map(row => row.location_name) : [],
            values: Array.isArray(results) ? results.map(row => row.total_views || 0) : []
        });
    });
});

// API สำหรับดึงอันดับสถานที่ที่ถูกเลือกใส่ในทริปมากที่สุด (ปรับให้ทำงานร่วมกับช่วงเวลาของตาราง Trip)
router.get('/top-trip-locations', verifyAdminToken, (req, res) => {
    const { startDate, endDate } = req.query;
    let dateCondition = "";
    let queryParams = [];

    if (startDate && endDate) {
        dateCondition = " AND t.created_at BETWEEN ? AND ? ";
        queryParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
    }

    const sql = `
        SELECT l.location_name, COUNT(td.location_id) as select_count
        FROM Location l
        JOIN Trip_Detail td ON l.location_id = td.location_id
        JOIN Trip t ON td.trip_id = t.trip_id
        WHERE l.is_deleted = 0 ${dateCondition}
        GROUP BY l.location_id, l.location_name
        ORDER BY select_count DESC
        LIMIT 5
    `;

    db.query(sql, queryParams, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            labels: (results && results.length > 0) ? results.map(row => row.location_name) : [],
            values: (results && results.length > 0) ? results.map(row => row.select_count) : []
        });
    });
});

// ดึงคำขอโฆษณาใหม่ล่าสุดที่รอดำเนินการ 3 รายการแรก
router.get('/recent-banners', verifyAdminToken, (req, res) => {
    const sql = "SELECT banner_id, title, status, created_at FROM Banners WHERE status = 'pending' ORDER BY created_at DESC LIMIT 3";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ดึงรายงานปัญหาล่าสุดที่รอดำเนินการ
router.get('/recent-reports', verifyAdminToken, (req, res) => {
    const sql = "SELECT r.reason_type, r.description, r.status, r.created_at, u.username AS reporter_name FROM account_reports r JOIN User u ON r.reporter_id = u.user_id WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 5";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ดึงประวัติกิจกรรมแอดมิน 5 รายการล่าสุด
router.get('/recent-activities', verifyAdminToken, (req, res) => {
    const sql = "SELECT u.username AS admin_name, al.action_type, al.table_name, al.description, al.created_at FROM Activity_Logs al LEFT JOIN User u ON al.admin_id = u.user_id ORDER BY al.created_at DESC LIMIT 5";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results || []);
    });
});

module.exports = router;