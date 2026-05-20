const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // ดึงใช้งานไลบรารี JWT สำหรับตรวจสอบสิทธิ์ตั๋วแอดมิน
const upload = require('../middleware/upload');

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ฟังก์ชันสแกนตั๋วแอดมินก่อนปล่อยผ่านเข้าถึงข้อมูลโครงข่ายแผนที่เส้นทาง
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

// ดึงหมุดพร้อมรายละเอียดสถานที่
router.get('/locations', (req, res) => {
    const sql = `
        SELECT 
            m.*, 
            l.location_name, l.operating_days, l.opening_time, l.closing_time, l.recommended_duration
        FROM Map m
        LEFT JOIN Location l ON m.location_id = l.location_id
        WHERE m.is_deleted = 0
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database Error');
        }
        res.json(results);
    });
});

// จัดลำดับสถานที่ท่องเที่ยว
async function sortLocations(locations, db, tripDate) {
    return new Promise((resolve, reject) => {
        const sqlLoc = `SELECT location_id, location_name, location_type, opening_time, closing_time, recommended_duration FROM Location WHERE location_id IN (?)`;
        const sqlRoute = `SELECT from_location_id, to_location_id, distance, travel_time_walk FROM Travel_Route WHERE from_location_id IN (?) AND to_location_id IN (?)`;

        db.query(sqlLoc, [locations], (err, locs) => {
            if (err) return reject(err);
            db.query(sqlRoute, [locations, locations], (err, routes) => {
                if (err) return reject(err);

                let sorted = [];
                let remaining = [...locs];

                const now = new Date();
                const isToday = now.toDateString() === new Date(tripDate).toDateString();
                let simTimeSec = isToday ? timeToSeconds(now.toTimeString().split(' ')[0]) : timeToSeconds("09:00:00");

                let candidates = remaining.filter(loc => loc.location_type !== 'โรงแรม');

                candidates.sort((a, b) => {
                    let aOpen = timeToSeconds(a.opening_time);
                    let bOpen = timeToSeconds(b.opening_time);
                    let aIsAvailable = aOpen <= simTimeSec;
                    let bIsAvailable = bOpen <= simTimeSec;

                    if (aIsAvailable && !bIsAvailable) return -1;
                    if (!aIsAvailable && bIsAvailable) return 1;
                    return a.closing_time.localeCompare(b.closing_time);
                });

                let startLoc = candidates[0];
                if (!startLoc) startLoc = remaining[0]; // Fallback เผื่อเลือกมาเฉพาะโรงแรม

                let startIndex = remaining.findIndex(l => l.location_id === startLoc.location_id);
                let current = remaining.splice(startIndex, 1)[0];
                sorted.push(current);

                simTimeSec = Math.max(simTimeSec, timeToSeconds(current.opening_time)) + ((current.recommended_duration || 30) * 60);

                while (remaining.length > 0) {
                    let lastId = current.location_id;
                    let bestIdx = -1;
                    let minScore = Infinity;

                    remaining.forEach((dest, index) => {
                        const route = routes.find(r =>
                            (r.from_location_id === lastId && r.to_location_id === dest.location_id) ||
                            (r.from_location_id === dest.location_id && r.to_location_id === lastId)
                        );

                        let distance = route ? parseFloat(route.distance) : 1000;
                        let travelSec = route ? (parseInt(route.travel_time_walk) * 60) : 300;
                        let arrivalTimeSec = simTimeSec + travelSec;
                        let openTimeSec = timeToSeconds(dest.opening_time);
                        let closeTimeSec = timeToSeconds(dest.closing_time);

                        let distanceScore = distance * 2.0;

                        let waitPenalty = 0;
                        if (arrivalTimeSec < openTimeSec) {
                            let waitTime = openTimeSec - arrivalTimeSec;
                            waitPenalty = waitTime > 900 ? 1000000 + (waitTime * 100) : (waitTime * 10);
                        }

                        let hotelScore = 0;
                        const hasOtherOptions = remaining.some(loc => loc.location_type !== 'โรงแรม');
                        if (dest.location_type === 'โรงแรม') {
                            hotelScore = hasOtherOptions ? 10000000 : (arrivalTimeSec < timeToSeconds("14:00:00") ? 500000 : 0);
                        }

                        let closedPenalty = (arrivalTimeSec > closeTimeSec) ? 5000000 : 0;
                        let totalScore = distanceScore + waitPenalty + hotelScore + closedPenalty;

                        if (totalScore < minScore) {
                            minScore = totalScore;
                            bestIdx = index;
                        }
                    });

                    current = remaining.splice(bestIdx, 1)[0];
                    sorted.push(current);

                    const routeBack = routes.find(r =>
                        (r.from_location_id === lastId && r.to_location_id === current.location_id) ||
                        (r.from_location_id === current.location_id && r.to_location_id === lastId)
                    );
                    let travelSecBack = routeBack ? (parseInt(routeBack.travel_time_walk) * 60) : 300;
                    simTimeSec = Math.max(simTimeSec + travelSecBack, timeToSeconds(current.opening_time)) + ((current.recommended_duration || 30) * 60);
                }
                resolve(sorted);
            });
        });
    });
}

function timeToDecimal(time) {
    const [h, m] = time.split(':').map(Number);
    return h + (m / 60);
}

function timeToSeconds(time) {
    if (!time) return 0;
    const [h, m, s] = time.split(':').map(Number);
    return h * 3600 + m * 60 + (s || 0);
}

// Route สำหรับสร้างทริปใหม่่
router.post('/create-trip', async (req, res) => {
    const { user_id, trip_name, trip_date, locations } = req.body;
    if (!locations || locations.length === 0) return res.status(400).send("No locations selected");

    try {
        const optimizedLocations = await sortLocations(locations, db, trip_date);
        const sqlGetFullInfo = `SELECT location_id, opening_time, closing_time, recommended_duration FROM Location WHERE location_id IN (?)`;

        db.query(sqlGetFullInfo, [locations], (err, locDetails) => {
            if (err) return res.status(500).send("Fetch Info Err");

            const infoMap = {};
            locDetails.forEach(d => infoMap[d.location_id] = d);

            const sqlAllRoutes = `SELECT * FROM Travel_Route WHERE from_location_id IN (?) OR to_location_id IN (?)`;

            db.query(sqlAllRoutes, [locations, locations], (err, allRoutes) => {
                if (err) return res.status(500).send("Fetch Routes Err");

                const now = new Date();
                const selectedDate = new Date(trip_date);
                let startDateTime = new Date(trip_date);

                const firstLocId = optimizedLocations[0].location_id;
                const firstLoc = infoMap[firstLocId];

                if (!firstLoc) return res.status(500).send("First Location Data Missing");

                const [openH, openM] = firstLoc.opening_time.split(':');
                startDateTime.setHours(parseInt(openH), parseInt(openM) + 30, 0);

                if (selectedDate.toDateString() === now.toDateString()) {
                    if (now > startDateTime) {
                        startDateTime = new Date(now.getTime() + 10 * 60000);
                    }
                }

                let runningTime = startDateTime;

                db.beginTransaction((err) => {
                    const sqlTrip = `INSERT INTO Trip (user_id, trip_name, trip_date, created_at) VALUES (?, ?, ?, NOW())`;
                    db.query(sqlTrip, [user_id, trip_name, trip_date], (err, result) => {
                        if (err) return db.rollback(() => res.status(500).send("Trip Err"));

                        const trip_id = result.insertId;
                        const detailValues = [];

                        optimizedLocations.forEach((loc, index) => {
                            const info = infoMap[loc.location_id];
                            const stayMin = info.recommended_duration || 30;
                            const openTimeSec = timeToSeconds(info.opening_time);

                            const arrivalTimeStr = runningTime.toTimeString().split(' ')[0];
                            const arrivalTimeSec = timeToSeconds(arrivalTimeStr);

                            let isWaiting = arrivalTimeSec < openTimeSec;
                            let activityStartDate = new Date(runningTime);

                            if (isWaiting) {
                                const [h, m] = info.opening_time.split(':');
                                activityStartDate.setHours(parseInt(h), parseInt(m), 0);
                            }

                            const finalDepartureTimeDate = new Date(activityStartDate.getTime() + stayMin * 60000);
                            const departureTimeStr = finalDepartureTimeDate.toTimeString().split(' ')[0];

                            detailValues.push([trip_id, loc.location_id, index + 1, arrivalTimeStr, stayMin, departureTimeStr]);

                            if (index < optimizedLocations.length - 1) {
                                const nextLocId = optimizedLocations[index + 1].location_id;

                                const routeInfo = allRoutes.find(r =>
                                    (r.from_location_id === loc.location_id && r.to_location_id === nextLocId) ||
                                    (r.from_location_id === nextLocId && r.to_location_id === loc.location_id)
                                );

                                const travelMin = routeInfo ? parseInt(routeInfo.travel_time_walk) : 5;
                                runningTime = new Date(finalDepartureTimeDate.getTime() + travelMin * 60000);
                            }
                        });

                        const sqlDetail = `INSERT INTO Trip_Detail (trip_id, location_id, visit_order, arrival_time, stay_duration, departure_time) VALUES ?`;
                        db.query(sqlDetail, [detailValues], (err) => {
                            if (err) return db.rollback(() => res.status(500).send("Detail Err"));
                            db.commit(() => res.json({ message: "Success", trip_id }));
                        });
                    });
                });
            });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route สำหรับดึงรายละเอียดทริปไปแสดงในหน้าสรุปแผนการเดินทาง
router.get('/trip-details/:id', (req, res) => {
    const tripId = req.params.id;
    const sql = `
        SELECT 
            td.trip_id, td.location_id, td.visit_order, td.arrival_time, td.stay_duration, td.departure_time,
            l.location_name, l.opening_time, l.closing_time, l.operating_days, t.trip_name,
            (SELECT image_url FROM Location_Images WHERE location_id = l.location_id AND is_deleted = 0 ORDER BY image_id ASC LIMIT 1) AS first_image,
            MAX(tr.distance) AS next_distance, MAX(tr.travel_time_walk) AS next_walk_time, MAX(tr.travel_time_bike) AS next_bike_time
        FROM Trip_Detail td
        JOIN Location l ON td.location_id = l.location_id
        JOIN Trip t ON td.trip_id = t.trip_id 
        LEFT JOIN Trip_Detail td_next ON td_next.trip_id = td.trip_id AND td_next.visit_order = td.visit_order + 1
        LEFT JOIN Travel_Route tr ON (
            (tr.from_location_id = td.location_id AND tr.to_location_id = td_next.location_id)
            OR 
            (tr.from_location_id = td_next.location_id AND tr.to_location_id = td.location_id)
        )
        WHERE td.trip_id = ?
        GROUP BY td.visit_order
        ORDER BY td.visit_order ASC
    `;
    db.query(sql, [tripId], (err, results) => {
        if (err) {
            console.error("SQL Error:", err);
            return res.status(500).json({ message: "Error" });
        }
        res.json(results);
    });
});

// ADMIN WORKSPACE ROUTES 

// ดึงหมุดระบุตำแหน่งฝั่งแผงแอดมิน
router.get('/pins', verifyAdminToken, (req, res) => {
    const sql = `
        SELECT m.*, l.location_name 
        FROM Map m 
        LEFT JOIN Location l ON m.location_id = l.location_id
        WHERE m.is_deleted = 0`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// บันทึกปักหมุดแผนที่ใหม่
router.post('/save', verifyAdminToken, upload.single('image'), (req, res) => {
    const { position_x, position_y, location_id, category, pin_icon, latitude, longitude, admin_id } = req.body;

    const finalImageUrl = req.file ? req.file.path : null;
    const finalIcon = pin_icon || JSON.stringify(['mdi:map-marker']);

    db.query("SELECT map_id FROM Map ORDER BY map_id DESC LIMIT 1", (err, results) => {
        let newId = "MAP-01";
        if (results.length > 0) {
            const num = parseInt(results[0].map_id.split('-')[1]) + 1;
            newId = `MAP-${num.toString().padStart(2, '0')}`;
        }

        const sql = "INSERT INTO Map (map_id, location_id, category, position_x, position_y, thumbnail_image, pin_icon, latitude, longitude, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        db.query(sql, [newId, location_id, category, position_x, position_y, finalImageUrl, finalIcon, latitude, longitude, admin_id], (err) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Insert', 'Map', newId, `เพิ่มหมุดใหม่บนแผนที่ (ID: ${newId})`, null, req.body);
            res.json({ success: true });
        });
    });
});

// อัปเดตพิกัด/ข้อมูลหมุดเดิม 
router.post('/update', verifyAdminToken, upload.single('image'), async (req, res) => {
    const { map_id, location_id, category, pin_icon, latitude, longitude, admin_id } = req.body;

    try {
        const oldValue = await getOldValue('Map', 'map_id', map_id);
        if (!oldValue) return res.status(404).json({ message: "ไม่พบข้อมูลหมุดพิกัด" });

        // ถ้าส่งค่าสถานที่มาเป็นค่าว่าง ให้แปลงไทป์เป็น null ทันที ป้องกัน error
        const safeLocationId = (location_id === "" || location_id === "null" || location_id === "undefined") ? null : location_id;
        const finalImageUrl = req.file ? req.file.path : oldValue.thumbnail_image;

        const sql = `UPDATE Map 
                     SET location_id = ?, category = ?, pin_icon = ?, 
                         latitude = ?, longitude = ?, thumbnail_image = ?, 
                         updated_by = ?, updated_at = NOW() 
                     WHERE map_id = ?`;

        const params = [safeLocationId, category, pin_icon, latitude, longitude, finalImageUrl, admin_id, map_id];

        db.query(sql, params, (err) => {
            if (err) {
                console.error("❌ SQL Update Pin Error:", err);
                return res.status(500).json(err);
            }
            recordLog(admin_id, 'Update', 'Map', map_id, `แก้ไขข้อมูลหมุดแผนที่รหัส: ${map_id}`, oldValue, { location_id: safeLocationId, category, pin_icon, latitude, longitude, thumbnail_image: finalImageUrl });
            res.json({ success: true });
        });
    } catch (error) {
        res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" });
    }
});

// สั่งลบหมุดระบุพิกัดสารสนเทศลงถังขยะ
router.delete('/delete/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const mapId = req.params.id;
    try {
        const oldValue = await getOldValue('Map', 'map_id', mapId);
        const sql = "UPDATE Map SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE map_id = ?";
        db.query(sql, [admin_id, mapId], (err) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Delete', 'Map', mapId, `ลบหมุดแผนที่รหัส: ${mapId} ย้ายลงสู่ถังขยะระบบ`, oldValue, { is_deleted: 1 });
            res.json({ success: true });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ดึงรายละเอียดเส้นทางทั้งหมด
router.get('/routes/:fromId', verifyAdminToken, (req, res) => {
    const sql = `SELECT tr.*, l.location_name as to_location_name FROM Travel_Route tr JOIN Location l ON tr.to_location_id = l.location_id WHERE tr.from_location_id = ? AND tr.is_deleted = 0`;
    db.query(sql, [req.params.fromId], (err, results) => res.json(results));
});

router.post('/routes/add', verifyAdminToken, (req, res) => {
    const { from_id, to_id, walk, bike, dist, admin_id } = req.body;
    db.query("SELECT travel_route_id FROM Travel_Route ORDER BY travel_route_id DESC LIMIT 1", (err, results) => {
        let newId = 'TR-001';
        if (results.length > 0) {
            const num = parseInt(results[0].travel_route_id.split('-')[1]) + 1;
            newId = 'TR-' + num.toString().padStart(3, '0');
        }
        const sql = "INSERT INTO Travel_Route (travel_route_id, from_location_id, to_location_id, travel_time_walk, travel_time_bike, distance, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)";
        db.query(sql, [newId, from_id, to_id, walk, bike, dist, admin_id], (err) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Insert', 'Travel_Route', newId, `เพิ่มเส้นทางใหม่รหัส: ${newId}`, null, req.body);
            res.json({ success: true, newId });
        });
    });
});

router.delete('/routes/delete/:id', verifyAdminToken, async (req, res) => {
    const { admin_id } = req.body;
    const routeId = req.params.id;
    try {
        const oldValue = await getOldValue('Travel_Route', 'travel_route_id', routeId);
        db.query("UPDATE Travel_Route SET is_deleted = 1, deleted_at = NOW(), deleted_by = ? WHERE travel_route_id = ?", [admin_id, routeId], (err) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Delete', 'Travel_Route', routeId, `ลบเส้นทางรหัส: ${routeId}`, oldValue, { is_deleted: 1 });
            res.json({ success: true });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/routes/update', verifyAdminToken, async (req, res) => {
    const { travel_route_id, travel_time_walk, travel_time_bike, distance, admin_id } = req.body;
    try {
        const oldValue = await getOldValue('Travel_Route', 'travel_route_id', travel_route_id);
        db.query("UPDATE Travel_Route SET travel_time_walk = ?, travel_time_bike = ?, distance = ?, updated_by = ?, updated_at = NOW() WHERE travel_route_id = ?", [travel_time_walk, travel_time_bike, distance, admin_id, travel_route_id], (err) => {
            if (err) return res.status(500).json(err);
            recordLog(admin_id, 'Update', 'Travel_Route', travel_route_id, `แก้ไขข้อมูลเส้นทางรหัส: ${travel_route_id}`, oldValue, req.body);
            res.json({ success: true });
        });
    } catch (error) { res.status(500).json({ error: "ดึงข้อมูลเดิมล้มเหลว" }); }
});

module.exports = router;