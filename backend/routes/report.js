const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสอบสิทธิ์ความปลอดภัยแอดมิน

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูลการร้องเรียนและสั่งระงับผู้ใช้
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
        next(); // ผ่านเงื่อนไข อนุญาตให้ไปทำขั้นตอนต่อไปได้
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

// นักท่องเที่ยวทั่วไปกดส่งเรื่องรายงานผู้ใช้พฤติกรรมไม่เหมาะสม
router.post('/report-user', (req, res) => {
    const { reporter_id, reported_user_id, reason_type, description } = req.body;

    if (!reporter_id || !reported_user_id || !reason_type) {
        return res.status(400).json({ message: "ข้อมูลไม่ครบถ้วน" });
    }

    const sql = `
        INSERT INTO account_reports (reporter_id, reported_user_id, reason_type, description) 
        VALUES (?, ?, ?, ?)
    `;

    db.query(sql, [reporter_id, reported_user_id, reason_type, description], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: "เกิดข้อผิดพลาดในการบันทึกข้อมูล" });
        }
        res.status(200).json({ message: "รายงานเรียบร้อยแล้ว" });
    });
});

// ดึงรายการ Report ทั้งหมด
router.get('/account-reports', verifyAdminToken, (req, res) => {
    const sql = `
        SELECT r.*, u1.username AS reporter_name, u2.username AS reported_name 
        FROM account_reports r
        JOIN User u1 ON r.reporter_id = u1.user_id
        JOIN User u2 ON r.reported_user_id = u2.user_id
        ORDER BY r.created_at DESC
    `;
    db.query(sql, (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result);
    });
});

// จัดการ Action ระงับหรือเพิกเฉยรายงานปัญหา:
router.put('/account-reports/action/:report_id', verifyAdminToken, async (req, res) => {
    const { action_type, reported_user_id, admin_id } = req.body;
    const reportId = req.params.report_id;

    try {
        const oldValue = await getOldValue('account_reports', 'report_id', reportId);

        if (action_type === 'banned') {
            const banSql = "UPDATE User SET status = 'banned' WHERE user_id = ?";
            db.query(banSql, [reported_user_id], (err) => {
                if (err) console.error("Ban User Error:", err);
            });
        }

        const updateReportSql = `
            UPDATE account_reports 
            SET status = 'checked', 
                updated_by = ?, 
                updated_at = NOW() 
            WHERE report_id = ?
        `;

        db.query(updateReportSql, [admin_id, reportId], (err, result) => {
            if (err) return res.status(500).json(err);

            const actionDetail = action_type === 'banned' ? 'ระงับการใช้งานผู้ใช้จากการรายงาน' : 'ตรวจสอบรายงานแล้ว (เพิกเฉย)';
            recordLog(admin_id, 'Update', 'account_reports', reportId, actionDetail, oldValue, { status: 'checked', action: action_type });

            res.json({ success: true });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;