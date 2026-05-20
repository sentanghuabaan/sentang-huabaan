const express = require('express');
const router = express.Router();
const db = require('../config/db');
const multer = require('multer');
const jwt = require('jsonwebtoken');

// ดึง Cloudinary เข้ามาใช้งาน
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// ตั้งค่าการเชื่อมต่อ (ดึงค่าจาก .env)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'huabaan_banners',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    },
});

const upload = multer({ storage: storage });

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูล
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

// ฟังก์ชันสำหรับดึงค่าข้อมูลเก่ามาเตรียมพ่วงลงระบบประวัติย้อนหลัง (Logs)
const getOldValue = (table, idColumn, idValue) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM ${table} WHERE ${idColumn} = ?`;
        db.query(sql, [idValue], (err, results) => {
            if (err) reject(err);
            resolve(results.length > 0 ? results[0] : null);
        });
    });
};

// ฟังก์ชันเตรียมเขียนข้อมูลการกระทำของแอดมินลงตารางระบบตรวจสอบสิทธิ์กลาง
const recordLog = (admin_id, action_type, table_name, target_id, description, old_value = null, new_value = null) => {
    const sql = `INSERT INTO Activity_Logs (admin_id, action_type, table_name, target_id, description, old_value, new_value) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.query(sql, [
        admin_id,
        action_type,
        table_name,
        target_id,
        description,
        old_value ? JSON.stringify(old_value) : null,
        new_value ? JSON.stringify(new_value) : null
    ], (err) => {
        if (err) console.error("❌ Log Recording Error:", err);
    });
};

// API สำหรับดึง Banner
router.get('/banners/active', (req, res) => {
    const query = `
        SELECT * FROM Banners 
        WHERE is_deleted = 0 
        AND status = 'approved' 
        AND (
            CURDATE() BETWEEN start_date AND end_date
            OR (start_date > CURDATE() AND start_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY))
        )
        ORDER BY start_date ASC
    `;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// API สำหรับบันทึกโฆษณาใหม่
router.post('/banners/add', upload.single('adImage'), (req, res) => {
    let { title, description, target_url, user_id, start_date, end_date } = req.body;

    if (!req.file) {
        return res.status(400).json({ error: "กรุณาอัปโหลดรูปภาพ" });
    }

    const image_url = req.file.path;

    const final_start_date = (!start_date || start_date === 'null' || start_date === '')
        ? new Date().toISOString().split('T')[0]
        : start_date;

    const final_end_date = (!end_date || end_date === 'null' || end_date === '')
        ? '2036-12-31'
        : end_date;

    const query = `
        INSERT INTO Banners (user_id, title, description, image_url, target_url, start_date, end_date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `;

    db.query(query, [user_id, title, description, image_url, target_url, final_start_date, final_end_date], (err, result) => {
        if (err) {
            console.error("Database Error:", err);
            return res.status(500).json({ error: "ไม่สามารถบันทึกข้อมูลได้" });
        }
        res.json({ message: "ส่งข้อมูลโฆษณาเรียบร้อย รอแอดมินอนุมัติ", id: result.insertId, url: image_url });
    });
});

// ดึงข้อมูลทั้งหมดสำหรับ Admin: ใส่ระบบตรวจสิทธิ์ verifyAdminToken ป้องกันช่องโหว่ข้อมูลรั่วไหล
router.get('/banners/all', verifyAdminToken, (req, res) => {
    const query = "SELECT * FROM Banners WHERE is_deleted = 0 ORDER BY created_at DESC";
    db.query(query, (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// ดึงข้อมูลโฆษณาเฉพาะของ User คนนั้นๆ
router.get('/banners/user/:user_id', (req, res) => {
    const userId = req.params.user_id;
    const query = `
        SELECT * FROM Banners 
        WHERE user_id = ? 
        AND is_deleted = 0 
        ORDER BY created_at DESC
    `;
    db.query(query, [userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// อัปเดตสถานะ (Approve / Reject)
router.put('/banners/status/:banner_id', verifyAdminToken, async (req, res) => {
    const { status, admin_note, admin_id } = req.body;
    const bannerId = req.params.banner_id;

    try {
        const oldValue = await getOldValue('Banners', 'banner_id', bannerId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลโฆษณาชิ้นนี้" });

        const query = "UPDATE Banners SET status = ?, admin_note = ? WHERE banner_id = ?";
        db.query(query, [status, admin_note, bannerId], (err, result) => {
            if (err) return res.status(500).send(err);

            const statusText = status === 'approved' ? 'อนุมัติการแสดงผล (Approved)' : 'ปฏิเสธการลงโฆษณา (Rejected)';
            const desc = `พิจารณาคำร้องแบนเนอร์โฆษณาหัวข้อ "${oldValue.title}": เปลี่ยนสถานะเป็น ${statusText}`;

            // บันทึกความเปลี่ยนแปลงลงระบบเพื่อนำไปฟีดขึ้นแดชบอร์ดหลักภาพรวม
            recordLog(admin_id, 'Update', 'Banners', bannerId, desc, oldValue, { status, admin_note });

            res.json({ message: "Status updated with note" });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ย้ายลงถังขยะ: คุมสิทธิ์ความปลอดภัยด้วย verifyAdminToken พร้อมระบบประเมินค่าความเปลี่ยนแปลงลงประวัติ Logs
router.put('/banners/delete/:banner_id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const bannerId = req.params.banner_id;

    try {
        const oldValue = await getOldValue('Banners', 'banner_id', bannerId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลโฆษณาที่ต้องการลบ" });

        const query = "UPDATE Banners SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE banner_id = ?";
        db.query(query, [admin_id, bannerId], (err, result) => {
            if (err) return res.status(500).send(err);

            // บันทึกกิจกรรมการทำลาย/ลบข้อมูลแบนเนอร์ร้านค้าลงในถังขยะ
            recordLog(
                admin_id,
                'Delete',
                'Banners',
                bannerId,
                `ลบแบนเนอร์โฆษณาหัวข้อ: "${oldValue.title}" ย้ายลงสู่ถังขยะส่วนกลาง`,
                oldValue,
                { is_deleted: 1 }
            );

            res.json({ message: "Banner moved to trash" });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;