const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');
const upload = require('../middleware/upload'); // เรียกใช้งานส่งไฟล์ขึ้น Cloud Cloudinary

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

const verifyAdminToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: "Access Denied: No Token Provided" });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: "Invalid or Expired Token" });
        req.admin = decoded;
        next();
    });
};

const getOldValue = (table, idColumn, idValue) => {
    return new Promise((resolve, reject) => {
        db.query(`SELECT * FROM ${table} WHERE ${idColumn} = ?`, [idValue], (err, results) => {
            if (err) reject(err);
            resolve(results.length > 0 ? results[0] : null);
        });
    });
};

// ฟังก์ชันกลางสำหรับบันทึก Activity Log
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

// CUSTOMER PUBLIC ENDPOINTS

// ดึงข้อมูลวิดีโอ AR ทั้งหมด
router.get('/', (req, res) => {
    db.query("SELECT * FROM VideoAR WHERE is_deleted = 0 ORDER BY target_index ASC", (err, results) => {
        if (err) return res.status(500).json({ error: "Database failure" });
        res.json(results);
    });
});

// บันทึกบวกคะแนนสถิติยอดการเข้าดู
router.post('/record-view/:id', (req, res) => {
    db.query("UPDATE VideoAR SET view_count = view_count + 1 WHERE video_id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "AR View recorded successfully" });
    });
});

// แอดมินเพิ่มวิดีโอใหม่
router.post('/', verifyAdminToken, upload.single('video'), (req, res) => {
    const { video_id, location_id, video_name, video_url, target_index, status, admin_id } = req.body;

    const finalVideoUrl = req.file ? req.file.path : video_url;

    const sql = "INSERT INTO VideoAR (video_id, location_id, video_name, video_url, target_index, status, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)";
    db.query(sql, [video_id, location_id, video_name, finalVideoUrl, target_index, status, admin_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: "Added successfully" });
    });
});

// ส่องตรวจสอบดูรหัส ID ถัดไป
router.get('/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(CAST(SUBSTRING(video_id, 3) AS UNSIGNED)) as max_id FROM VideoAR", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextNum = (result[0].max_id || 0) + 1;
        res.json({ next_id: `V-${nextNum.toString().padStart(3, '0')}` });
    });
});

// ดึงข้อมูลวิดีโอตัวที่ต้องการแก้ไขมาพรีวิว
router.get('/:id', verifyAdminToken, (req, res) => {
    db.query("SELECT * FROM VideoAR WHERE video_id = ?", [req.params.id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result[0]);
    });
});

// แอดมินแก้ไขวิดีโอเดิม
router.put('/:id', verifyAdminToken, upload.single('video'), async (req, res) => {
    const { location_id, video_name, video_url, target_index, status, admin_id } = req.body;
    const vidId = req.params.id;

    try {
        const oldValue = await getOldValue('VideoAR', 'video_id', vidId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูล" });

        const finalVideoUrl = req.file ? req.file.path : (video_url || oldValue.video_url);

        const sql = "UPDATE VideoAR SET location_id=?, video_name=?, video_url=?, target_index=?, status=?, updated_by=?, updated_at=NOW() WHERE video_id=?";
        db.query(sql, [location_id, video_name, finalVideoUrl, target_index, status, admin_id, vidId], (err) => {
            if (err) return res.status(500).json(err);
            res.json({ message: "Updated" });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// สั่งลบคอนเทนต์วิดีโอลงถังขยะ
router.delete('/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const vidId = req.params.id;
    try {
        const sql = "UPDATE VideoAR SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE video_id = ?";
        db.query(sql, [admin_id, vidId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "ย้ายข้อมูลลงถังขยะสำเร็จ" });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;