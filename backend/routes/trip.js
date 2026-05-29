const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสอบสิทธิ์ความปลอดภัยแอดมิน

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

//ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูลสร้างทริป
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


// CUSTOMER PUBLIC ENDPOINTS 

// ดึงข้อมูลประวัติแผนการเดินทางของผู้ใช้รายคน
router.get('/my-trips/:user_id', (req, res) => {
    const { user_id } = req.params;
    const sortOrder = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

    const query = `
        SELECT 
            t.trip_id, t.trip_name, t.created_at,
            td.arrival_time, td.visit_order,
            l.location_name,
            (SELECT image_url FROM Location_Images WHERE location_id = l.location_id LIMIT 1) AS location_image
        FROM Trip t
        LEFT JOIN Trip_Detail td ON t.trip_id = td.trip_id
        LEFT JOIN Location l ON td.location_id = l.location_id 
        WHERE t.user_id = ? AND t.is_deleted = 0
        ORDER BY t.created_at ${sortOrder}, t.trip_id DESC, td.visit_order ASC
    `;

    db.query(query, [user_id], (err, rows) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ error: err.message });
        }

        if (!rows || rows.length === 0) {
            return res.json([]);
        }

        const formattedData = rows.reduce((acc, item) => {
            let found = acc.find(trip => trip.trip_id === item.trip_id);
            const locationData = {
                name: item.location_name,
                time: item.arrival_time,
                image: item.location_image
            };

            if (found) {
                found.locations.push(locationData);
            } else {
                acc.push({
                    trip_id: item.trip_id,
                    trip_name: item.trip_name,
                    created_at: item.created_at,
                    locations: [locationData]
                });
            }
            return acc;
        }, []);

        res.json(formattedData);
    });
});


// ADMIN WORKSPACE ENDPOINTS

// ดึงข้อมูลทริปทั้งหมดขึ้นผังแอดมิน
router.get('/', verifyAdminToken, (req, res) => {
    const sql = `SELECT t.*, u.username 
                 FROM Trip t 
                 LEFT JOIN User u ON t.user_id = u.user_id 
                 WHERE t.is_deleted = 0 
                 ORDER BY t.created_at DESC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// สั่งลบทริปขยะ/สแปมล้างระบบแบบแพ็ก Transaction
router.delete('/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const tripId = req.params.id;

    try {
        const oldValue = await getOldValue('Trip', 'trip_id', tripId);

        if (!oldValue) {
            return res.status(404).json({ message: "ไม่พบข้อมูลทริป" });
        }

        db.beginTransaction((err) => {
            if (err) return res.status(500).json({ error: err.message });

            const sqlTrip = "UPDATE Trip SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE trip_id = ?";
            const sqlDetail = "UPDATE Trip_Detail SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE trip_id = ?";

            db.query(sqlTrip, [admin_id, tripId], (err) => {
                if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                db.query(sqlDetail, [admin_id, tripId], (err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                    db.commit((err) => {
                        if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                        recordLog(
                            admin_id,
                            'Delete',
                            'Trip',
                            tripId,
                            `ลบทริปชื่อ: ${oldValue.trip_name} (User ID: ${oldValue.user_id}) ย้ายข้อมูลลงถังขยะส่วนกลาง`,
                            oldValue,
                            { is_deleted: 1 }
                        );

                        res.json({ success: true });
                    });
                });
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ผู้ใช้กดลบประวัติแผนการเดินทางของตัวเอง 
router.put('/my-trips/delete/:id', (req, res) => {
    const tripId = req.params.id;
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: "ข้อมูลสิทธิ์ผู้ใช้ไม่ครบถ้วน" });
    }

    db.getConnection((connErr, connection) => {
        if (connErr) {
            console.error("❌ [Pool Error] Cannot get connection from pool:", connErr);
            return res.status(500).json({ error: "ไม่สามารถเชื่อมต่อฐานข้อมูลได้ในขณะนี้" });
        }

        connection.beginTransaction((transactionErr) => {
            if (transactionErr) {
                console.error("❌ [Transaction Error] Init Failed:", transactionErr);
                connection.release();
                return res.status(500).json({ error: "ไม่สามารถเริ่มบันทึกธุรกรรมฐานข้อมูลได้" });
            }

            const sqlTrip = "UPDATE Trip SET is_deleted = 1, deleted_at = NOW() WHERE trip_id = ? AND user_id = ?";
            const sqlDetail = "UPDATE Trip_Detail SET is_deleted = 1, deleted_at = NOW() WHERE trip_id = ?";

            connection.query(sqlTrip, [tripId, user_id], (tripErr, result) => {
                if (tripErr) {
                    console.error("❌ [SQL Error] Trip table update failed:", tripErr.message);
                    return connection.rollback(() => {
                        connection.release();
                        res.status(500).json({ error: "บันทึกข้อมูลหลักทริปไม่สำเร็จ", details: tripErr.message });
                    });
                }

                if (result.affectedRows === 0) {
                    return connection.rollback(() => {
                        connection.release();
                        res.status(404).json({ error: "ไม่พบข้อมูลแผนการเดินทาง หรือคุณไม่มีสิทธิ์เข้าถึง" });
                    });
                }

                connection.query(sqlDetail, [Number(tripId)], (detailErr) => {
                    if (detailErr) {
                        console.error("❌ [SQL Error] Trip_Detail table update failed:", detailErr.message);
                        return connection.rollback(() => {
                            connection.release();
                            res.status(500).json({ error: "รูปแบบข้อมูลรายละเอียดขัดแย้งกับฐานข้อมูล", details: detailErr.message });
                        });
                    }

                    connection.commit((commitErr) => {
                        if (commitErr) {
                            console.error("❌ [Transaction Error] Commit failed:", commitErr.message);
                            return connection.rollback(() => {
                                connection.release();
                                res.status(500).json({ error: "ยืนยันบันทึกข้อมูลธุรกรรมทริปล้มเหลว" });
                            });
                        }

                        connection.release();
                        console.log(`🎉 [Success] Soft delete trip id: ${tripId} completely.`);
                        res.json({ success: true, message: "ลบประวัติการเดินทางเรียบร้อยแล้ว" });
                    });
                });
            });
        });
    });
});

// ดึงผังรายละเอียดลำดับ Trip Detail
router.get('/details', verifyAdminToken, (req, res) => {
    const sql = `SELECT td.* FROM Trip_Detail td 
                 JOIN Trip t ON td.trip_id = t.trip_id 
                 WHERE t.is_deleted = 0 AND td.is_deleted = 0 
                 ORDER BY td.trip_id, td.visit_order ASC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// สถิตินับจำนวนพิกัดยอดนิยมในการจัดทริป
router.get('/stats', verifyAdminToken, (req, res) => {
    const sql = `
        SELECT l.location_name, COUNT(td.location_id) as usage_count 
        FROM Trip_Detail td
        JOIN Location l ON td.location_id = l.location_id
        GROUP BY l.location_id
        ORDER BY usage_count DESC 
        LIMIT 5`;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

module.exports = router;