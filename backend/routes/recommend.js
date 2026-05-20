const express = require('express');
const router = express.Router();
const db = require('../config/db');
const e = require('express');

router.get('/recommendations', (req, res) => {
    const userLat = parseFloat(req.query.lat);
    const userLng = parseFloat(req.query.lng);
    const type = req.query.type || 'all';

    let sql = `
        SELECT 
            l.location_id, l.location_name, l.location_type, 
            l.opening_time, l.closing_time, l.operating_days,
            m.latitude, m.longitude, 
            m.map_id, m.position_x, m.position_y, m.pin_icon, m.thumbnail_image,
            (6371 * acos(
                cos(radians(?)) * cos(radians(m.latitude)) * 
                cos(radians(m.longitude) - radians(?)) + 
                sin(radians(?)) * sin(radians(m.latitude))
            )) AS distance
        FROM Map m
        LEFT JOIN Location l ON m.location_id = l.location_id
        WHERE m.is_deleted = 0 
          AND (
            l.location_id IS NULL OR 
            (l.is_deleted = 0 AND (l.location_type LIKE ? OR ? = 'all'))
          )
    `;

    // เรียงตามระยะทาง
    const queryParams = [userLat, userLng, userLat, `%${type}%`, type];
    sql += ` ORDER BY distance ASC LIMIT 100`;

    db.query(sql, queryParams, (err, results) => {
        if (err) {
            console.error('SQL Error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

module.exports = router;