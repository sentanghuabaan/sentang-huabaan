const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสอบสิทธิ์ความปลอดภัยแอดมิน

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

//ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูลชั้นความลับประวัติ Logs ทั้งระบบ
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

// API สำหรับดึงประวัติกิจกรรมทั้งหมด
router.get('/admin/activity-logs', verifyAdminToken, (req, res) => {
    const sql = `
        SELECT 
            al.*, 
            u.username AS admin_name 
        FROM Activity_Logs al
        LEFT JOIN User u ON al.admin_id = u.user_id
        ORDER BY al.created_at DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

module.exports = router;