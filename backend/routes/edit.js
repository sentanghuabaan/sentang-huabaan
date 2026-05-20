const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสิทธิ์ความปลอดภัย
const upload = require('../middleware/upload');

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ฟังก์ชันสแกนตั๋วตรวจสอบผู้ใช้งานจริงก่อนอนุญาตให้ปรับเปลี่ยนโปรไฟล์
const verifyUserToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: "Access Denied: ไม่พบตราประทับสิทธิ์ระบบ" });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ success: false, message: "Invalid or Expired Token" });
        }
        req.user = decoded;
        next();
    });
};

router.put('/update-profile', verifyUserToken, upload.single('profile_img'), (req, res) => {
    const { user_id, new_username, new_email } = req.body;

    let profileImgUrl = req.file ? req.file.path : null;

    if (!user_id) {
        return res.status(400).json({ success: false, message: "ไม่พบข้อมูล User ID" });
    }
    if (String(req.user.user_id) !== String(user_id)) {
        return res.status(403).json({ success: false, message: "Unauthorized: บัญชีของคุณไม่มีสิทธิ์แก้ไขข้อมูลผู้อื่น" });
    }

    let sql = "";
    let params = [];

    if (profileImgUrl) {
        sql = `
            UPDATE User 
            SET username = ?, 
                email = ?, 
                profile_img = ?, 
                updated_at = NOW(),
                updated_by = ?
            WHERE user_id = ?
        `;
        params = [new_username, new_email, profileImgUrl, user_id, user_id];
    } else {
        sql = `
            UPDATE User 
            SET username = ?, 
                email = ?, 
                updated_at = NOW(),
                updated_by = ?
            WHERE user_id = ?
        `;
        params = [new_username, new_email, user_id, user_id];
    }

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error("❌ Database Error:", err);
            return res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการบันทึกข้อมูล" });
        }

        if (result.affectedRows > 0) {
            res.json({
                success: true,
                message: "อัปเดตโปรไฟล์สำเร็จ",
                profile_img: profileImgUrl ? profileImgUrl : undefined
            });
        } else {
            res.status(404).json({ success: false, message: "ไม่พบผู้ใช้งาน" });
        }
    });
});

module.exports = router;