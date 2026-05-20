const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสอบสิทธิ์ตั๋วแอดมิน
const upload = require('../middleware/upload');

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูลสารบบวิจารณ์รีวิวระบบ
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
        next(); // ตั๋วถูกต้องและสิทธิ์ผ่าน ทำงานได้ทันที
    });
};

const getOldValue = (table, idColumn, idValue) => {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM ${table} WHERE ${idColumn} = ?`;
        db.query(sql, [idValue], (err, results) => {
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

// เรียกดูรีวิวรวมแยกตามสถานที่/กิจกรรม
router.get('/reviews', (req, res) => {
    const { act_id, loc_id } = req.query;

    let sql = `SELECT Review.*, User.username, User.profile_img 
               FROM Review 
               LEFT JOIN User ON Review.user_id = User.user_id 
               WHERE (Review.status = 'active' OR Review.status IS NULL OR Review.status = '')`;

    const params = [];
    if (act_id && act_id !== 'null' && act_id !== 'undefined') {
        sql += " AND Review.activity_id = ?";
        params.push(act_id);
    }

    if (loc_id && loc_id !== 'null' && loc_id !== 'undefined') {
        sql += " AND Review.location_id = ?";
        params.push(loc_id);
    }

    sql += " ORDER BY Review.created_at DESC";

    db.query(sql, params, (err, result) => {
        if (err) {
            console.error("SQL Error:", err);
            return res.status(500).json([]);
        }
        res.json(result);
    });
});

// ผู้ใช้กดส่งบันทึกรีวิวใหม่
router.post('/save_review', upload.array('review_images', 5), (req, res) => {
    let { user_id, location_id, activity_id, rating, review_text } = req.body;

    db.query("SELECT review_id FROM Review ORDER BY review_id DESC LIMIT 1", (err, results) => {
        let nextId = "REV-001";
        if (results.length > 0) {
            const lastNumber = parseInt(results[0].review_id.replace("REV-", ""));
            nextId = `REV-${(lastNumber + 1).toString().padStart(3, '0')}`;
        }

        const imageUrls = req.files ? req.files.map(f => f.path).join(',') : '';

        const sql = "INSERT INTO Review (review_id, user_id, location_id, activity_id, rating, review_text, review_image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())";
        db.query(sql, [nextId, user_id, location_id, activity_id, rating, review_text, imageUrls], (err) => {
            if (err) return res.status(500).json(err);
            res.status(200).json({ success: true, new_id: nextId });
        });
    });
});

// ดึงรายการประวัติรีวิวเก่าเฉพาะบุคคลผู้ใช้คนนั้น ๆ 
router.get('/my-reviews/:user_id', (req, res) => {
    const userId = req.params.user_id;
    const sortBy = req.query.sort;

    let orderBy = "ORDER BY r.created_at DESC";

    if (sortBy === 'highest') {
        orderBy = "ORDER BY r.rating DESC, r.created_at DESC";
    } else if (sortBy === 'lowest') {
        orderBy = "ORDER BY r.rating ASC, r.created_at DESC";
    }

    const sql = `
        SELECT r.*, l.location_name, a.activity_name 
        FROM Review r
        LEFT JOIN Location l ON r.location_id = l.location_id
        LEFT JOIN Activity a ON r.activity_id = a.activity_id
        WHERE r.user_id = ? AND r.is_deleted = 0
        ${orderBy}`;

    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});


// ADMIN WORKSPACE ENDPOINTS 

// เรียกดูรายการรีวิวทั้งหมดฝั่งแอดมิน
router.get('/admin/reviews', verifyAdminToken, (req, res) => {
    const sql = `
        SELECT r.*, u.username, l.location_name, a.activity_name 
        FROM Review r 
        LEFT JOIN User u ON r.user_id = u.user_id 
        LEFT JOIN Location l ON r.location_id = l.location_id
        LEFT JOIN Activity a ON r.activity_id = a.activity_id
        WHERE r.is_deleted = 0
        ORDER BY r.created_at DESC`;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// แอดมินสั่งเซ็ตสลับสถานะเปิด/ซ่อนความคิดเห็นรีวิว
router.put('/reviews/:id/status', verifyAdminToken, async (req, res) => {
    const { status, hide_reason, admin_id } = req.body;
    const reviewId = req.params.id;

    try {
        const oldValue = await getOldValue('Review', 'review_id', reviewId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลรีวิวชิ้นนี้" });

        const sql = "UPDATE Review SET status = ?, hide_reason = ?, updated_by = ?, updated_at = NOW() WHERE review_id = ?";
        const reason = status === 'active' ? null : hide_reason;

        db.query(sql, [status, reason, admin_id, reviewId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });

            const actionDetail = status === 'active' ? 'เปิดการแสดงผลรีวิว' : `ซ่อนรีวิวเนื่องจาก: ${hide_reason}`;
            recordLog(admin_id, 'Update', 'Review', reviewId, actionDetail, oldValue, req.body);

            res.json({ message: "Status Updated Successfully" });
        });
    } catch (error) {
        res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" });
    }
});

// สั่ง Soft Delete ย้ายรีวิวไม่เหมาะสมลงถังขยะ
router.delete('/reviews/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const reviewId = req.params.id;

    try {
        const oldValue = await getOldValue('Review', 'review_id', reviewId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลรีวิวที่ต้องการลบ" });

        const sql = "UPDATE Review SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE review_id = ?";

        db.query(sql, [admin_id, reviewId], (err, result) => {
            if (err) {
                console.error("Delete Error:", err);
                return res.status(500).json({ error: err.message });
            }

            recordLog(admin_id, 'Delete', 'Review', reviewId, `ลบรีวิวของผู้ใช้รหัส: ${oldValue ? oldValue.user_id : 'Unknown'}`, oldValue, { is_deleted: 1 });

            res.json({ message: "ย้ายรีวิวไปถังขยะสำเร็จ" });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;