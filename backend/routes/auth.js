const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken'); // การดึงใช้งานไลบรารี JWT สำหรับสร้างตั๋วลับ
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

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
        // ตรวจสอบภายในตั๋วว่ามีบทบาทเป็น admin หรือไม่
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

// Login
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM User WHERE email = ? AND password = ?";
    db.query(sql, [email, password], (err, result) => {
        if (err) return res.status(500).json({ message: "Error" });
        if (result.length > 0) {
            const user = result[0];
            if (user.status === 'banned') {
                return res.status(403).json({ success: false, message: "บัญชีของคุณถูกระงับ" });
            }

            const token = jwt.sign(
                { user_id: user.user_id, username: user.username, role: user.role },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                success: true,
                token: token,
                user_id: user.user_id,
                role: user.role,
                username: user.username,
                profile_img: user.profile_img
            });
        }
        res.status(401).json({ success: false, message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
    });
});

// Register
router.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    db.query("SELECT * FROM User WHERE email = ?", [email], (err, result) => {
        if (result && result.length > 0) return res.json({ success: false, message: "อีเมลนี้ถูกใช้งานแล้ว" });
        const sql = "INSERT INTO User (username, email, password, role, status) VALUES (?, ?, ?, 'user', 'active')";
        db.query(sql, [username, email, password], (err, result) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, user: { id: result.insertId, username, email } });
        });
    });
});

// Admin: Users list & Update
router.get('/admin/users', verifyAdminToken, (req, res) => {
    db.query("SELECT user_id, username, email, role, status, ban_reason, profile_img FROM User", (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

router.post('/admin/update-status', verifyAdminToken, async (req, res) => {
    const { user_id, status, ban_reason, admin_id } = req.body;
    const reason = (status === 'banned') ? ban_reason : null;

    try {
        const oldValue = await getOldValue('User', 'user_id', user_id);

        const sql = `
            UPDATE User 
            SET status = ?, 
                ban_reason = ?, 
                updated_by = ?, 
                updated_at = NOW() 
            WHERE user_id = ?
        `;

        db.query(sql, [status, reason, admin_id, user_id], (err, result) => {
            if (err) return res.status(500).json({ success: false });

            const actionText = status === 'banned' ? `ระงับการใช้งานผู้ใช้ (Banned)` : `ปลดระงับการใช้งาน (Active)`;
            const logDescription = status === 'banned' ? `${actionText} เนื่องจาก: ${ban_reason}` : actionText;

            recordLog(admin_id, status === 'banned' ? 'Banned' : 'Update', 'User', user_id, logDescription, oldValue, { status, ban_reason });

            res.json({ success: true, message: "อัปเดตสถานะเรียบร้อยแล้ว" });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/admin/update-role', verifyAdminToken, async (req, res) => {
    const { user_id, role, admin_id } = req.body;

    try {
        const oldValue = await getOldValue('User', 'user_id', user_id);

        db.query("UPDATE User SET role = ?, updated_by = ? WHERE user_id = ?", [role, admin_id, user_id], (err) => {
            if (err) return res.status(500).json({ success: false });

            recordLog(admin_id, 'Update', 'User', user_id, `เปลี่ยนสิทธิ์ผู้ใช้งานเป็น: ${role.toUpperCase()}`, oldValue, { role });

            res.json({ success: true });
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ตั้งค่า Passport สำหรับ Google
passport.use(new GoogleStrategy({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback"
},
    function (accessToken, refreshToken, profile, done) {
        const googleId = profile.id;
        const email = profile.emails[0].value;
        const username = profile.displayName;

        const sql = "SELECT * FROM User WHERE google_id = ? OR email = ?";
        db.query(sql, [googleId, email], (err, result) => {
            if (result.length > 0) {
                return done(null, result[0]);
            } else {
                const insertSql = "INSERT INTO User (username, email, google_id, role, status, is_verified) VALUES (?, ?, ?, 'user', 'active', 1)";
                db.query(insertSql, [username, email, googleId], (err, resInsert) => {
                    const newUser = { user_id: resInsert.insertId, username, email, role: 'user' };
                    return done(null, newUser);
                });
            }
        });
    }
));

router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
        const user = req.user;

        const token = jwt.sign(
            { user_id: user.user_id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const username = encodeURIComponent(user.username);
        const email = encodeURIComponent(user.email);
        const role = user.role;
        const userId = user.user_id;

        // ดึงพาร์ทรูปอวาตาร์เดิมจากฐานข้อมูลส่งพ่วงแนบไปทาง URL ปลายทาง
        const profileImg = user.profile_img ? encodeURIComponent(user.profile_img) : '';

        res.redirect(`/index.html?user_id=${userId}&username=${username}&email=${email}&role=${role}&profile_img=${profileImg}&token=${token}`);
    }
);

passport.serializeUser((user, done) => {
    done(null, user.user_id);
});

passport.deserializeUser((id, done) => {
    const sql = "SELECT * FROM User WHERE user_id = ?";
    db.query(sql, [id], (err, result) => {
        done(err, result[0]);
    });
});

const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'sentanghuabaan@gmail.com',
        pass: 'wrse lzeu tgwu crno'
    }
});

// API สำหรับลงทะเบียนและส่ง OTP
router.post('/register-request', async (req, res) => {
    const { username, email, password } = req.body;

    const checkUserSql = "SELECT email FROM User WHERE email = ?";
    db.query(checkUserSql, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการตรวจสอบข้อมูล" });

        if (results.length > 0) {
            return res.status(400).json({ success: false, message: "อีเมลนี้ถูกใช้งานแล้ว กรุณาใช้อีเมลอื่นหรือเข้าสู่ระบบ" });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60000);

        const year = expiresAt.getFullYear();
        const month = String(expiresAt.getMonth() + 1).padStart(2, '0');
        const day = String(expiresAt.getDate()).padStart(2, '0');
        const hours = String(expiresAt.getHours()).padStart(2, '0');
        const minutes = String(expiresAt.getMinutes()).padStart(2, '0');
        const seconds = String(expiresAt.getSeconds()).padStart(2, '0');

        const formattedTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

        const sql = "INSERT INTO OTP_codes (email, otp_code, expires_at) VALUES (?, ?, ?)";
        db.query(sql, [email, otp, formattedTime], (err) => {
            if (err) return res.status(500).json({ success: false });

            const mailOptions = {
                from: '"เส้นทางหัวบ้าน" <sentanghuabaan@gmail.com>',
                to: email,
                subject: 'รหัสยืนยันการสมัครสมาชิก',
                text: `รหัส OTP ของคุณคือ: ${otp} (ใช้งานได้ใน 5 นาที)`
            };

            transporter.sendMail(mailOptions, (error) => {
                if (error) return res.status(500).json({ success: false, message: 'ส่งเมลไม่สำเร็จ' });
                res.json({ success: true, message: 'ส่ง OTP แล้ว' });
            });
        });
    });
});

// ฟังก์ชันยืนยันรหัส OTP สมัครสมาชิกใหม่
router.post('/verify-otp', (req, res) => {
    const { username, email, password, otp_code } = req.body;
    const checkOtpSql = "SELECT * FROM OTP_codes WHERE email = ? AND otp_code = ? ORDER BY id DESC LIMIT 1";

    db.query(checkOtpSql, [email, otp_code], (err, results) => {
        if (err || results.length === 0) {
            return res.status(400).json({ success: false, message: "รหัส OTP ไม่ถูกต้อง" });
        }

        const otpRecord = results[0];
        const now = new Date();
        const expiry = new Date(otpRecord.expires_at);

        if (now > expiry) {
            return res.status(400).json({ success: false, message: "รหัส OTP หมดอายุแล้ว" });
        }

        // สั่งสร้างโปรไฟล์ใหม่ลงฐานข้อมูล
        const insertUserSql = "INSERT INTO User (username, email, password, role, status, is_verified) VALUES (?, ?, ?, 'user', 'active', 1)";

        db.query(insertUserSql, [username, email, password], (insertErr, result) => {
            if (insertErr) {
                console.error("❌ Insert User Error:", insertErr);
                return res.status(500).json({ success: false, message: "อีเมลนี้อาจถูกใช้งานไปแล้ว" });
            }

            const newUserId = result.insertId;

            const token = jwt.sign(
                { user_id: newUserId, username: username, role: 'user' },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            db.query("DELETE FROM OTP_codes WHERE email = ?", [email]);

            res.json({
                success: true,
                token: token,
                user: { 
                    user_id: newUserId,
                    username: username, 
                    email: email, 
                    role: 'user',
                    profile_img: null
                }
            });
        });
    });
});

// API สำหรับขอรีเซ็ตรหัสผ่าน (ส่ง OTP)
router.post('/forgot-password', (req, res) => {
    const { email } = req.body;

    db.query("SELECT * FROM User WHERE email = ?", [email], (err, result) => {
        if (err) return res.status(500).json({ success: false });
        if (result.length === 0) return res.status(404).json({ success: false, message: "ไม่พบอีเมลนี้ในระบบ" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60000);

        const year = expiresAt.getFullYear();
        const month = String(expiresAt.getMonth() + 1).padStart(2, '0');
        const day = String(expiresAt.getDate()).padStart(2, '0');
        const hours = String(expiresAt.getHours()).padStart(2, '0');
        const minutes = String(expiresAt.getMinutes()).padStart(2, '0');
        const seconds = String(expiresAt.getSeconds()).padStart(2, '0');

        const formattedTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

        const sql = "INSERT INTO OTP_codes (email, otp_code, expires_at) VALUES (?, ?, ?)";
        db.query(sql, [email, otp, formattedTime], (err) => {
            if (err) {
                console.error("❌ Database Error:", err);
                return res.status(500).json({ success: false, message: "บันทึก OTP ไม่สำเร็จ" });
            }

            const mailOptions = {
                from: '"เส้นทางหัวบ้าน" <sentanghuabaan@gmail.com>',
                to: email,
                subject: 'รหัสสำหรับรีเซ็ตรหัสผ่าน',
                text: `รหัส OTP สำหรับตั้งรหัสผ่านใหม่ของคุณคือ: ${otp} (ใช้งานได้ใน 5 นาที)`
            };

            transporter.sendMail(mailOptions, (error) => {
                if (error) return res.status(500).json({ success: false, message: 'ส่งเมลไม่สำเร็จ' });
                res.json({ success: true, message: 'ส่ง OTP เรียบร้อย' });
            });
        });
    });
});

// API สำหรับเช็ค OTP  
router.post('/verify-otp-only', (req, res) => {
    const { email, otp_code } = req.body;
    const sql = "SELECT * FROM OTP_codes WHERE email = ? AND otp_code = ? ORDER BY id DESC LIMIT 1";

    db.query(sql, [email, otp_code], (err, results) => {
        if (err) return res.status(500).json({ success: false });

        if (results.length > 0) {
            const otpRecord = results[0];
            const expiryTime = new Date(otpRecord.expires_at).getTime();
            const currentTime = new Date().getTime();

            if (currentTime > expiryTime) {
                return res.status(400).json({ success: false, message: "รหัส OTP หมดอายุแล้ว" });
            }

            res.json({ success: true, message: "รหัสถูกต้อง" });
        } else {
            res.status(400).json({ success: false, message: "รหัส OTP ไม่ถูกต้อง" });
        }
    });
});

// API สำหรับตั้งรหัสผ่านใหม่
router.post('/reset-password', (req, res) => {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
        return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

    const updateSql = "UPDATE User SET password = ? WHERE email = ?";
    db.query(updateSql, [newPassword, email], (err, result) => {
        if (err) {
            console.error("❌ SQL Error:", err);
            return res.status(500).json({ success: false, message: "บันทึกข้อมูลไม่สำเร็จ" });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบอีเมลนี้ในระบบ" });
        }

        db.query("DELETE FROM OTP_codes WHERE email = ?", [email]);
        return res.status(200).json({ success: true, message: "เปลี่ยนรหัสผ่านสำเร็จ" });
    });
});

// ดึงข้อมูล OTP ทั้งหมด
router.get('/otp', verifyAdminToken, (req, res) => {
    db.query("SELECT * FROM OTP_codes ORDER BY expires_at DESC", (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// เพิ่ม Route สำหรับลบ OTP 
router.delete('/otp/:id', verifyAdminToken, async (req, res) => {
    const otpId = req.params.id;
    const { admin_id } = req.body;

    try {
        const oldValue = await getOldValue('OTP_codes', 'id', otpId);

        if (!oldValue) {
            return res.status(404).json({ message: "ไม่พบข้อมูล OTP" });
        }

        db.query("DELETE FROM OTP_codes WHERE id = ?", [otpId], (err, result) => {
            if (err) return res.status(500).json(err);

            recordLog(
                admin_id,
                'Delete',
                'OTP_codes',
                otpId,
                `ลบรหัส OTP ของอีเมล: ${oldValue.email}`,
                oldValue,
                null
            );

            res.json({ message: "Deleted successfully" });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function clearExpiredOTPs() {
    const sql = "DELETE FROM OTP_codes WHERE expires_at < NOW()";
    db.query(sql, (err, result) => {
        if (err) {
            console.error("Error clearing expired OTPs:", err);
            return;
        }
        if (result.affectedRows > 0) {
            console.log(`Cleaned up ${result.affectedRows} expired OTPs from the database.`);
        }
    });
}

setTimeout(clearExpiredOTPs, 3000);
setInterval(clearExpiredOTPs, 3600000);

module.exports = router;