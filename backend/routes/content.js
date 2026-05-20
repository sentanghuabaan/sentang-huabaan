const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสอบสิทธิ์ตั๋วแอดมิน
const upload = require('../middleware/upload');

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


// LOCATIONS ROUTES

// ดึงภาพสถานที่
router.get('/locations/:id/images', (req, res) => {
    const locationId = req.params.id;
    const sql = "SELECT image_url FROM Location_Images WHERE location_id = ? AND is_deleted = 0 ORDER BY image_id ASC";
    db.query(sql, [locationId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ดึงสถานที่ทั้งหมด
router.get('/locations', (req, res) => {
    db.query("SELECT * FROM Location WHERE is_deleted = 0", (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result);
    });
});

// ส่องดูรหัสไอดีถัดไปของสถานที่
router.get('/locations/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(CAST(SUBSTRING(location_id, 5) AS UNSIGNED)) as max_id FROM Location", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextNum = (result[0].max_id || 0) + 1;
        const nextId = `LOC-${nextNum.toString().padStart(3, '0')}`;
        res.json({ next_id: nextId });
    });
});

// ดึงข้อมูลสถานที่แต่ละ ID
router.get('/locations/:id', (req, res) => {
    const locId = req.params.id;
    db.query('SELECT * FROM Location WHERE location_id = ? AND is_deleted = 0', [locId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!result || result.length === 0) return res.status(404).json({ message: "ไม่พบข้อมูลสถานที่" });
        res.json(result[0]);
    });
});

// เพิ่มสถานที่ท่องเที่ยวใหม่
router.post('/locations', verifyAdminToken, upload.single('image'), (req, res) => {
    const {
        location_id, location_name, location_details, location_type,
        opening_time, closing_time, operating_days, recommended_duration, location_url, admin_id
    } = req.body;

    const finalImageUrl = req.file ? req.file.path : location_url;

    const sql = `INSERT INTO Location (location_id, location_name, location_details, location_type, 
                 opening_time, closing_time, operating_days, recommended_duration, location_url, updated_by) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [
        location_id, location_name, location_details, location_type,
        opening_time, closing_time, operating_days, recommended_duration, finalImageUrl, admin_id
    ], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        recordLog(admin_id, 'Insert', 'Location', location_id, `เพิ่มสถานที่ใหม่: ${location_name}`, null, req.body);
        res.json({ success: true, message: 'เพิ่มสถานที่สำเร็จ' });
    });
});

// แก้ไขข้อมูลสถานที่ท่องเที่ยวเดิม
router.put('/locations/:id', verifyAdminToken, upload.single('image'), async (req, res) => {
    const locId = req.params.id;
    const {
        location_name, location_details, location_type, opening_time,
        closing_time, operating_days, recommended_duration, admin_id
    } = req.body;

    try {
        const oldValue = await getOldValue('Location', 'location_id', locId);
        if (!oldValue) return res.status(404).json({ success: false, message: "ไม่พบข้อมูลสถานที่" });

        const finalImageUrl = (req.file && req.file.path) ? req.file.path : oldValue.location_url;

        const safeDurationNum = recommended_duration && recommended_duration !== 'null' ? parseInt(recommended_duration) : (oldValue.recommended_duration || 0);

        let safeAdminId = (admin_id && admin_id !== 'null' && admin_id !== 'undefined') ? parseInt(admin_id) : null;
        if (!safeAdminId && req.admin && req.admin.user_id) safeAdminId = parseInt(req.admin.user_id);
        if (!safeAdminId) safeAdminId = oldValue.updated_by || 1;

        const sql = `UPDATE Location 
                     SET location_name = ?, location_details = ?, location_type = ?, 
                         opening_time = ?, closing_time = ?, operating_days = ?, 
                         recommended_duration = ?, location_url = ?, updated_by = ?, updated_at = NOW()
                     WHERE location_id = ?`;

        db.query(sql, [
            location_name || oldValue.location_name,
            location_details || oldValue.location_details,
            location_type || oldValue.location_type,
            opening_time || oldValue.opening_time,
            closing_time || oldValue.closing_time,
            operating_days || oldValue.operating_days,
            safeDurationNum,
            finalImageUrl,
            safeAdminId,
            locId
        ], (err, result) => {
            if (err) {
                console.error("❌ SQL Update Error ตัวจริงมาแล้ว:", err);
                return res.status(500).json({ success: false, error: err.message });
            }
            recordLog(safeAdminId, 'Update', 'Location', locId, `แก้ไขข้อมูลสถานที่: ${location_name}`, oldValue, {
                location_name, location_details, location_type, opening_time, closing_time, operating_days, recommended_duration: safeDurationNum, location_url: finalImageUrl
            });
            res.json({ success: true, message: "อัปเดตข้อมูลเสร็จสมบูรณ์" });
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ย้ายสถานที่ลงถังขยะ (Soft Delete)
router.delete('/locations/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const locId = req.params.id;
    try {
        const oldValue = await getOldValue('Location', 'location_id', locId);
        const sql = "UPDATE Location SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE location_id = ?";
        db.query(sql, [admin_id, locId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Delete', 'Location', locId, `ย้ายสถานที่ชื่อ "${oldValue ? oldValue.location_name : locId}" ลงถังขยะ`, oldValue, { is_deleted: 1 });
            res.json({ success: true, message: 'ย้ายข้อมูลลงถังขยะสำเร็จ' });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ACTIVITIES ROUTES 

// ดึงภาพของกิจกรรม 
router.get('/activities/:id/images', (req, res) => {
    const activityId = req.params.id;
    const sql = "SELECT image_url FROM Activity_Images WHERE activity_id = ? AND is_deleted = 0 ORDER BY image_id ASC";
    db.query(sql, [activityId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ดึงกิจกรรมชุมชนทั้งหมด
router.get('/activities', (req, res) => {
    const sql = "SELECT Activity.*, Location.location_name FROM Activity LEFT JOIN Location ON Activity.location_id = Location.location_id WHERE Activity.is_deleted = 0";
    db.query(sql, (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result);
    });
});

// ดึงข้อมูลกิจกรรมแต่ละ ID
router.get('/activities/:id', (req, res) => {
    const activityId = req.params.id;
    const sql = "SELECT Activity.*, Location.location_name FROM Activity LEFT JOIN Location ON Activity.location_id = Location.location_id WHERE Activity.activity_id = ? AND Activity.is_deleted = 0";
    db.query(sql, [activityId], (err, result) => {
        if (err) return res.status(500).json(err);
        if (result.length === 0) return res.status(404).json({ message: "Activity not found" });
        res.json(result[0]);
    });
});

// ส่องดูรหัสไอดีถัดไปของกิจกรรม
router.get('/activities/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(CAST(SUBSTRING(activity_id, 5) AS UNSIGNED)) as max_id FROM Activity", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextNum = (result[0].max_id || 0) + 1;
        const nextId = `ACT-${nextNum.toString().padStart(2, '0')}`;
        res.json({ next_id: nextId });
    });
});

// เพิ่มกิจกรรมชุมชนชิ้นใหม่
router.post('/activities', verifyAdminToken, upload.single('image'), (req, res) => {
    const {
        activity_id, activity_name, location_id, activity_details,
        start_time, end_time, activity_date, price_detail, activity_url, admin_id
    } = req.body;
    const locId = location_id === "" ? null : location_id;
    const finalImageUrl = req.file ? req.file.path : activity_url;

    const sql = `INSERT INTO Activity (activity_id, activity_name, location_id, activity_details, 
                 start_time, end_time, activity_date, price_detail, activity_url, updated_by) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [
        activity_id, activity_name, locId, activity_details,
        start_time, end_time, activity_date, price_detail, finalImageUrl, admin_id
    ], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        recordLog(admin_id, 'Insert', 'Activity', activity_id, `เพิ่มกิจกรรมใหม่: ${activity_name}`, null, req.body);
        res.status(201).json({ success: true, message: 'เพิ่มกิจกรรมสำเร็จ' });
    });
});

// แก้ไขข้อมูลแผนกิจกรรมเดิม
router.put('/activities/:id', verifyAdminToken, upload.single('image'), async (req, res) => {
    const actId = req.params.id;
    const {
        activity_name, location_id, activity_details,
        start_time, end_time, activity_date, price_detail, activity_url, admin_id
    } = req.body;
    const locId = location_id === "" ? null : location_id;

    try {
        const oldValue = await getOldValue('Activity', 'activity_id', actId);
        if (!oldValue) return res.status(404).json({ success: false, message: "ไม่พบข้อมูลกิจกรรม" });

        const finalImageUrl = (req.file && req.file.path) ? req.file.path : (activity_url || oldValue.activity_url);

        let safeAdminId = (admin_id && admin_id !== 'null' && admin_id !== 'undefined') ? parseInt(admin_id) : null;
        if (!safeAdminId && req.admin && req.admin.user_id) safeAdminId = parseInt(req.admin.user_id);
        if (!safeAdminId) safeAdminId = oldValue.updated_by || 1;

        const sql = `UPDATE Activity 
                     SET activity_name = ?, location_id = ?, activity_details = ?, 
                         start_time = ?, end_time = ?, activity_date = ?, 
                         price_detail = ?, activity_url = ?, 
                         updated_by = ?, updated_at = NOW() 
                     WHERE activity_id = ?`;

        db.query(sql, [
            activity_name || oldValue.activity_name,
            locId,
            activity_details || oldValue.activity_details,
            start_time || oldValue.start_time,
            end_time || oldValue.end_time,
            activity_date || oldValue.activity_date,
            price_detail || oldValue.price_detail,
            finalImageUrl,
            safeAdminId,
            actId
        ], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(safeAdminId, 'Update', 'Activity', actId, `แก้ไขข้อมูลกิจกรรม: ${activity_name}`, oldValue, {
                activity_name, location_id: locId, activity_details, start_time, end_time, activity_date, price_detail, activity_url: finalImageUrl
            });
            res.json({ success: true, message: 'แก้ไขข้อมูลสำเร็จ' });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ลบแผนกิจกรรมชุมชนลงถังขยะ
router.delete('/activities/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const actId = req.params.id;
    try {
        const oldValue = await getOldValue('Activity', 'activity_id', actId);
        const sql = "UPDATE Activity SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE activity_id = ?";
        db.query(sql, [admin_id, actId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Delete', 'Activity', actId, `ย้ายกิจกรรมลงถังขยะ: ${oldValue ? oldValue.activity_name : actId}`, oldValue, { is_deleted: 1 });
            res.json({ success: true, message: 'ย้ายข้อมูลลงถังขยะสำเร็จ' });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});


// MULTIPLE IMAGES & GALLERIES MANAGEMENT

// ดึงข้อมูลคลังภาพกิจกรรมฝั่งแอดมินเพจ
router.get('/activity-images', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM Activity_Images WHERE is_deleted = 0', (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// เพิ่มข้อมูลภาพพาร์ทแกลเลอรีกิจกรรมใหม่
router.post('/activity-images', verifyAdminToken, upload.single('image'), (req, res) => {
    const { image_id, activity_id, image_url, admin_id } = req.body;

    const finalImageUrl = req.file ? req.file.path : image_url;

    const sql = "INSERT INTO Activity_Images (image_id, activity_id, image_url, updated_by) VALUES (?, ?, ?, ?)";
    db.query(sql, [image_id, activity_id, finalImageUrl, admin_id], (err, result) => {
        if (err) return res.status(500).json(err);
        recordLog(admin_id, 'Insert', 'Activity_Images', image_id, `เพิ่มรูปภาพใหม่ให้กิจกรรมรหัส: ${activity_id}`, null, req.body);
        res.status(201).json({ message: "Added successfully" });
    });
});

// ตรวจดูรหัส ID ถัดไปของภาพกิจกรรม
router.get('/activity-images/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(image_id) as max_id FROM Activity_Images", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextId = (result[0].max_id || 0) + 1;
        res.json({ next_id: nextId });
    });
});

// ดึงข้อมูลรายรูปภาพกิจกรรม
router.get('/activity-images/:id', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM Activity_Images WHERE image_id = ? AND is_deleted = 0', [req.params.id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result[0]);
    });
});

// อัปเดตปรับแก้พาร์ทข้อมูลรูปกิจกรรม
router.put('/activity-images/:id', verifyAdminToken, upload.single('image'), async (req, res) => {
    const { activity_id, image_url, admin_id } = req.body;
    const imgId = req.params.id;

    try {
        const oldValue = await getOldValue('Activity_Images', 'image_id', imgId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลรูปภาพประกอบชิ้นนี้" });

        const finalImageUrl = req.file ? req.file.path : (image_url || oldValue.image_url);

        const sql = `UPDATE Activity_Images SET activity_id = ?, image_url = ?, updated_by = ?, updated_at = NOW() WHERE image_id = ?`;
        db.query(sql, [activity_id, finalImageUrl, admin_id, imgId], (err, result) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Update', 'Activity_Images', imgId, `แก้ไขรูปภาพรหัส: ${imgId} ของกิจกรรม: ${activity_id}`, oldValue, { activity_id, image_url: finalImageUrl });
            res.json({ message: "Updated" });
        });
    } catch (error) {
        res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" });
    }
});

// สั่งย้ายภาพกิจกรรมท่องเที่ยวลงถังขยะ
router.delete('/activity-images/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const imgId = req.params.id;
    try {
        const oldValue = await getOldValue('Activity_Images', 'image_id', imgId);
        const sql = "UPDATE Activity_Images SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE image_id = ?";
        db.query(sql, [admin_id, imgId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Delete', 'Activity_Images', imgId, `ลบรูปภาพกิจกรรมรหัส: ${imgId} ลงถังขยะ`, oldValue, { is_deleted: 1 });
            res.json({ message: "ย้ายข้อมูลลงถังขยะสำเร็จ" });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// LOCATION_IMAGES ROUTES

// เรียกประมวลข้อมูลรูปภาพคลังสถานที่ท่องเที่ยวทั้งหมด
router.get('/location-images', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM Location_Images WHERE is_deleted = 0', (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// ส่องดูโครงรหัสเลขถัดไป Auto Increment
router.get('/location-images/next-id', verifyAdminToken, (req, res) => {
    db.query("SHOW TABLE STATUS LIKE 'Location_Images'", (err, result) => {
        if (err || result.length === 0) return res.status(500).json({ error: "ไม่สามารถดึง ID ล่าสุดได้" });
        res.json({ next_id: result[0].Auto_increment });
    });
});

// เพิ่มข้อมูลภาพพาร์ทแกลเลอรี่ชิ้นใหม่
router.post('/location-images', verifyAdminToken, upload.single('image'), (req, res) => {
    const { location_id, image_url, admin_id } = req.body;

    const finalImageUrl = req.file ? req.file.path : image_url;

    const sql = 'INSERT INTO Location_Images (location_id, image_url, updated_by) VALUES (?, ?, ?)';
    db.query(sql, [location_id, finalImageUrl, admin_id], (err, result) => {
        if (err) return res.status(500).send(err);

        const newId = result.insertId;
        recordLog(admin_id, 'Insert', 'Location_Images', newId, `เพิ่มรูปภาพใหม่ให้สถานที่รหัส: ${location_id}`, null, req.body);

        res.json({ message: "Added" });
    });
});

// เรียกดูข้อมูลรายรูปภาพสถานที่เดิมเพื่อนำไปใส่หน้า Edit
router.get('/location-images/:id', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM Location_Images WHERE image_id = ? AND is_deleted = 0', [req.params.id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result[0]);
    });
});

// สั่งประมวลผลอัปเดตข้อมูลภาพสถานที่เดิม
router.put('/location-images/:id', verifyAdminToken, upload.single('image'), async (req, res) => {
    const { location_id, image_url, admin_id } = req.body;
    const imgId = req.params.id;

    try {
        const oldValue = await getOldValue('Location_Images', 'image_id', imgId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลรูปภาพ" });

        const finalImageUrl = (req.file && req.file.path) ? req.file.path : (image_url || oldValue.image_url);

        const sql = `UPDATE Location_Images SET location_id = ?, image_url = ?, updated_by = ? WHERE image_id = ?`;
        db.query(sql, [location_id, finalImageUrl, admin_id, imgId], (err, result) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Update', 'Location_Images', imgId, `แก้ไขรูปภาพรหัส: ${imgId} ของสถานที่: ${location_id}`, oldValue, { location_id, image_url: finalImageUrl });
            res.json({ message: "Updated successfully" });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// สั่งลบภาพพาร์ทสถานที่ลงถังขยะ
router.delete('/location-images/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const imgId = req.params.id;
    try {
        const oldValue = await getOldValue('Location_Images', 'image_id', imgId);
        const sql = "UPDATE Location_Images SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE image_id = ?";
        db.query(sql, [admin_id, imgId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Delete', 'Location_Images', imgId, `ลบรูปภาพสถานที่รหัส: ${imgId} ย้ายลงสู่ถังขยะระบบ`, oldValue, { is_deleted: 1 });
            res.json({ success: true, message: 'ย้ายลงถังขยะแล้ว' });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// gallery

// ดึงภาพรวมแกลเลอรีชุมชน 
router.get('/gallery', (req, res) => {
    db.query('SELECT * FROM Community_Gallery WHERE is_active = 1 AND is_deleted = 0 ORDER BY display_order ASC', (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// ส่องตรวจดูรหัสถัดไปของแกลเลอรีประวัติศาสตร์
router.get('/history-gallery/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(CAST(SUBSTRING(gallery_id, 5) AS UNSIGNED)) as max_id FROM History_Gallery", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextNum = (result[0].max_id || 0) + 1;
        const nextId = `GAL-${nextNum.toString().padStart(2, '0')}`;
        res.json({ next_id: nextId });
    });
});

// ส่องตรวจรายชื่อโครงแกลเลอรีประวัติศาสตร์ทั้งหมด
router.get('/history-gallery', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM History_Gallery WHERE is_deleted = 0', (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// สั่งย้ายภาพแกลเลอรีประวัติศาสตร์ลงถังขยะระบบ
router.delete('/history-gallery/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const galId = req.params.id;
    try {
        const oldValue = await getOldValue('History_Gallery', 'gallery_id', galId);
        const sql = "UPDATE History_Gallery SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE gallery_id = ?";
        db.query(sql, [admin_id, galId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Delete', 'History_Gallery', galId, `ลบรูปภาพประวัติรหัส: ${galId} ลงถังขยะ`, oldValue, { is_deleted: 1 });
            res.json({ message: "ย้ายข้อมูลลงถังขยะสำเร็จ" });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ดึงข้อมูลรายรูปภาพในแกลเลอรีประวัติศาสตร์เพื่อแก้ไข
router.get('/history-gallery/:id', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM History_Gallery WHERE gallery_id = ?', [req.params.id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result[0]);
    });
});

// สั่งบันทึกแก้ไขข้อมูลภาพแกลเลอรีประวัติศาสตร์
router.put('/history-gallery/:id', verifyAdminToken, upload.single('image'), async (req, res) => {
    const { history_id, image_url, admin_id } = req.body;
    const galId = req.params.id;

    try {
        const oldValue = await getOldValue('History_Gallery', 'gallery_id', galId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลรูปภาพประวัติศาสตร์ชิ้นนี้" });

        const finalImageUrl = req.file ? req.file.path : (image_url || oldValue.image_url);

        const sql = "UPDATE History_Gallery SET history_id = ?, image_url = ?, updated_by = ?, updated_at = NOW() WHERE gallery_id = ?";
        db.query(sql, [history_id, finalImageUrl, admin_id, galId], (err, result) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Update', 'History_Gallery', galId, `แก้ไขรูปภาพในคลังภาพประวัติศาสตร์ (Gallery ID: ${galId})`, oldValue, { history_id, image_url: finalImageUrl });
            res.json({ message: "Updated" });
        });
    } catch (error) {
        res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" });
    }
});

// เพิ่มรูปภาพใหม่ในคลังภาพประวัติศาสตร์
router.post('/history-gallery', verifyAdminToken, upload.single('image'), (req, res) => {
    const { gallery_id, history_id, image_url, admin_id } = req.body;

    const finalImageUrl = req.file ? req.file.path : image_url;

    const sql = "INSERT INTO History_Gallery (gallery_id, history_id, image_url, updated_by) VALUES (?, ?, ?, ?)";
    db.query(sql, [gallery_id, history_id, finalImageUrl, admin_id], (err, result) => {
        if (err) return res.status(500).json(err);
        recordLog(admin_id, 'Insert', 'History_Gallery', gallery_id, `เพิ่มรูปภาพใหม่ในคลังภาพประวัติศาสตร์ (History ID: ${history_id})`, null, req.body);
        res.status(201).json({ message: "Added successfully" });
    });
});

// history

// ดึงข้อมูลรายชื่อประวัติศาสตร์ 
router.get('/history', (req, res) => {
    const sql = `SELECT h.*, GROUP_CONCAT(g.image_url) as gallery_images 
                 FROM History h 
                 LEFT JOIN History_Gallery g ON h.history_id = g.history_id AND g.is_deleted = 0 
                 WHERE h.is_deleted = 0 
                 GROUP BY h.history_id 
                 ORDER BY h.sequence_order ASC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json([]);
        const data = results.map(item => ({ ...item, gallery_images: item.gallery_images ? item.gallery_images.split(',') : [] }));
        res.json(data);
    });
});

// ส่องตรวจสอบดูค่าไอดีถัดไปของตารางประวัติ
router.get('/history/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(CAST(SUBSTRING(history_id, 6) AS UNSIGNED)) as max_id FROM History", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextNum = (result[0].max_id || 0) + 1;
        const nextId = `HIST-${nextNum.toString().padStart(2, '0')}`;
        res.json({ next_id: nextId });
    });
});

// ดึงรายละเอียดชุดเนื้อหาข้อมูลประวัติศาสตร์แต่ละ ID
router.get('/history/:id', (req, res) => {
    const sql = "SELECT * FROM History WHERE history_id = ? AND is_deleted = 0";
    db.query(sql, [req.params.id], (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results[0]);
    });
});

// เพิ่มข้อมูลเนื้อหาประวัติศาสตร์ชิ้นใหม่
router.post('/history', verifyAdminToken, (req, res) => {
    const { history_id, title, content_text, video_url, sequence_order, admin_id } = req.body;
    const sql = "INSERT INTO History (history_id, title, content_text, video_url, sequence_order, updated_by) VALUES (?, ?, ?, ?, ?, ?)";
    db.query(sql, [history_id, title, content_text, video_url, sequence_order, admin_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        recordLog(admin_id, 'Insert', 'History', history_id, `เพิ่มข้อมูลประวัติใหม่: ${title}`, null, req.body);
        res.status(201).json({ message: "Added successfully" });
    });
});

// แก้ไขข้อมูลประวัติศาสตร์เดิม
router.put('/history/:id', verifyAdminToken, async (req, res) => {
    const { title, content_text, video_url, sequence_order, admin_id } = req.body;
    const histId = req.params.id;
    try {
        const oldValue = await getOldValue('History', 'history_id', histId);
        const sql = `UPDATE History SET title=?, content_text=?, video_url=?, sequence_order=?, updated_by=?, updated_at=NOW() WHERE history_id=?`;
        db.query(sql, [title, content_text, video_url, sequence_order, admin_id, histId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Update', 'History', histId, `แก้ไขข้อมูลประวัติ: ${title}`, oldValue, req.body);
            res.json({ message: "Updated" });
        });
    } catch (error) { res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" }); }
});

// ลบชุดไฟล์ประวัติลงถังขยะส่วนกลาง
router.delete('/history/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const histId = req.params.id;
    try {
        const oldValue = await getOldValue('History', 'history_id', histId);
        const sql = "UPDATE History SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE history_id = ?";
        db.query(sql, [admin_id, histId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            recordLog(admin_id, 'Delete', 'History', histId, `ย้ายข้อมูลประวัติลงถังขยะ: ${oldValue ? oldValue.title : histId}`, oldValue, { is_deleted: 1 });
            res.json({ success: true, message: 'ย้ายข้อมูลลงถังขยะสำเร็จ' });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});


// COMMUNITY GALLERY 


router.get('/community-gallery', (req, res) => {
    const sql = `SELECT * FROM Community_Gallery WHERE is_deleted = 0 ORDER BY display_order ASC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// ส่องตรวจสอบดูค่ารหัส ID ถัดไปของคลังภาพชุมชน
router.get('/community-gallery/next-id', verifyAdminToken, (req, res) => {
    db.query("SELECT MAX(CAST(SUBSTRING(image_id, 5) AS UNSIGNED)) as max_id FROM Community_Gallery WHERE is_deleted = 0", (err, result) => {
        if (err) return res.status(500).json(err);
        const nextNum = (result[0].max_id || 0) + 1;
        const nextId = `IMG-${nextNum.toString().padStart(3, '0')}`;
        res.json({ next_id: nextId });
    });
});

// สั่งย้ายภาพคลังแกลเลอรีชุมชนลงถังขยะ
router.delete('/community-gallery/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const imgId = req.params.id;
    try {
        const oldValue = await getOldValue('Community_Gallery', 'image_id', imgId);
        const sql = "UPDATE Community_Gallery SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE image_id = ?";
        db.query(sql, [admin_id, imgId], (err, result) => {
            if (err) return res.status(500).send(err);
            recordLog(admin_id, 'Delete', 'Community_Gallery', imgId, `ลบรูปภาพคอมมูนิตี้รหัส: ${imgId} ย้ายลงถังขยะระบบ`, oldValue, { is_deleted: 1 });
            res.json({ message: "ย้ายข้อมูลลงถังขยะสำเร็จ" });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// เพิ่มภาพใหม่ในแกลเลอรีชุมชน
router.post('/community-gallery', verifyAdminToken, upload.single('image'), (req, res) => {
    const { image_id, image_url, display_order, is_active, admin_id } = req.body;
    const finalImageUrl = req.file ? req.file.path : image_url;

    const sql = "INSERT INTO Community_Gallery (image_id, image_url, display_order, is_active, updated_by) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [image_id, finalImageUrl, display_order, is_active, admin_id], (err, result) => {
        if (err) return res.status(500).json(err);
        recordLog(admin_id, 'Insert', 'Community_Gallery', image_id, `เพิ่มรูปภาพใหม่ใน Community Gallery`, null, req.body);
        res.status(201).json({ message: "Added" });
    });
});

// ดึงรายละเอียดพาร์ทภาพแกลเลอรีคอมมูนิตี้รายตัวมาเตรียม Edit
router.get('/community-gallery/:id', verifyAdminToken, (req, res) => {
    db.query('SELECT * FROM Community_Gallery WHERE image_id = ? AND is_deleted = 0', [req.params.id], (err, result) => {
        if (err) return res.status(500).json(err);
        res.json(result[0]);
    });
});

// สั่งอัปเดตข้อมูลพาร์ทชิ้นรูปภาพคอมมูนิตี้เดิม
router.put('/community-gallery/:id', verifyAdminToken, upload.single('image'), async (req, res) => {
    const { image_url, display_order, is_active, admin_id } = req.body;
    const imgId = req.params.id;

    try {
        const oldValue = await getOldValue('Community_Gallery', 'image_id', imgId);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลแกลเลอรี" });

        const finalImageUrl = req.file ? req.file.path : (image_url || oldValue.image_url);

        const sql = "UPDATE Community_Gallery SET image_url = ?, display_order = ?, is_active = ?, updated_by = ?, updated_at = NOW() WHERE image_id = ?";
        db.query(sql, [finalImageUrl, display_order, is_active, admin_id, imgId], (err, result) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Update', 'Community_Gallery', imgId, `แก้ไขข้อมูลรูปภาพใน Community Gallery (Image ID: ${imgId})`, oldValue, { image_url: finalImageUrl, display_order, is_active });
            res.json({ message: "Updated" });
        });
    } catch (error) {
        res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" });
    }
});


// TRASH & RESTORE MANAGEMENT ROUTES

router.get('/trash/:table', verifyAdminToken, (req, res) => {
    const table = req.params.table;
    if (table === 'Location') {
        db.query("SELECT * FROM Location WHERE is_deleted = 1", (err, result) => { res.json(result); });
    }
    else if (table === 'Location_Images') {
        db.query(`SELECT img.*, loc.location_name FROM Location_Images img LEFT JOIN Location loc ON img.location_id = loc.location_id WHERE img.is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'Activity') {
        db.query("SELECT * FROM Activity WHERE is_deleted = 1", (err, result) => { res.json(result); });
    }
    else if (table === 'Activity_Images') {
        db.query(`SELECT img.*, act.activity_name FROM Activity_Images img LEFT JOIN Activity act ON img.activity_id = act.activity_id WHERE img.is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'History') {
        db.query(`SELECT * FROM History WHERE is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'History_Gallery') {
        db.query(`SELECT gallery.*, his.title as history_name FROM History_Gallery gallery LEFT JOIN History his ON gallery.history_id = his.history_id WHERE gallery.is_deleted = 1`, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(result);
        });
    }
    else if (table === 'VideoAR') {
        db.query(`SELECT * FROM VideoAR WHERE is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'Community_Gallery') {
        db.query(`SELECT * FROM Community_Gallery WHERE is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'Banners') {
        db.query("SELECT * FROM Banners WHERE is_deleted = 1 ORDER BY deleted_at DESC", (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(result);
        });
    }
    else if (table === 'Review') {
        db.query(`SELECT * FROM Review WHERE is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'Map') {
        db.query(`SELECT m.*, l.location_name FROM Map m LEFT JOIN Location l ON m.location_id = l.location_id WHERE m.is_deleted = 1`, (err, result) => { res.json(result); });
    }
    else if (table === 'Travel_Route') {
        db.query(`SELECT tr.*, l1.location_name as from_name, l2.location_name as to_name FROM Travel_Route tr LEFT JOIN Location l1 ON tr.from_location_id = l1.location_id LEFT JOIN Location l2 ON tr.to_location_id = l2.location_id WHERE tr.is_deleted = 1`, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            const data = result.map(item => ({ ...item, route_display_name: `${item.from_name || '...'} -> ${item.to_name || '...'}` }));
            res.json(data);
        });
    }
    else if (table === 'Trip') {
        db.query(`SELECT * FROM Trip WHERE is_deleted = 1`, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(result);
        });
    }
    else if (table === 'Trip_Detail') {
        db.query(`SELECT td.*, t.trip_name, l.location_name FROM Trip_Detail td LEFT JOIN Trip t ON td.trip_id = t.trip_id LEFT JOIN Location l ON td.location_id = l.location_id WHERE td.is_deleted = 1`, (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            const data = result.map(item => ({ ...item, detail_display_name: `ทริป: ${item.trip_name || '...'} | สถานที่: ${item.location_name || '...'}` }));
            res.json(data);
        });
    }
    else {
        db.query(`SELECT * FROM ?? WHERE is_deleted = 1`, [table], (err, result) => { res.json(result); });
    }
});

// สั่งรันกู้คืนข้อมูลจากถังขยะกลับคืนระบบ
router.put('/trash/restore/:table/:id', verifyAdminToken, (req, res) => {
    const table = req.params.table;
    const id = req.params.id;
    const { admin_id } = req.body;

    const idColumns = {
        'Location': 'location_id', 'Location_Images': 'image_id', 'Activity': 'activity_id',
        'Activity_Images': 'image_id', 'History': 'history_id', 'History_Gallery': 'gallery_id',
        'VideoAR': 'video_id', 'Community_Gallery': 'image_id', 'Banners': 'banner_id',
        'Review': 'review_id', 'Map': 'map_id', 'Travel_Route': 'travel_route_id',
        'Trip': 'trip_id', 'Trip_Detail': 'detail_id'
    };
    const idCol = idColumns[table];
    if (!idCol) return res.status(400).json({ error: "ไม่พบตารางนี้" });

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });
        let sql = `UPDATE ${table} SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE ${idCol} = ?`;

        db.query(sql, [id], (err, result) => {
            if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

            if (table === 'Trip') {
                const sqlDetail = "UPDATE Trip_Detail SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL WHERE trip_id = ?";
                db.query(sqlDetail, [id], (err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: err.message }));
                    db.commit((err) => {
                        if (err) return db.rollback(() => res.status(500).json({ error: err.message }));
                        recordLog(admin_id, 'Update', table, id, `กู้คืนข้อมูลทริปรหัส ${id} และรายละเอียดแผนทั้งหมดกลับมาจากถังขยะ`, null, { is_deleted: 0 });
                        res.json({ success: true });
                    });
                });
            } else {
                db.commit((err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: err.message }));
                    recordLog(admin_id, 'Update', table, id, `กู้คืนข้อมูลรหัส ${id} ในตาราง ${table} กลับมาใช้งานปกติ`, null, { is_deleted: 0 });
                    res.json({ success: true });
                });
            }
        });
    });
});

module.exports = router;