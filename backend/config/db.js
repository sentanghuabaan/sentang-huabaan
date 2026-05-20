const path = require('path');
const mysql = require('mysql2');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

let db;
let connectionType = "";

// ดักจับตรวจสถานะรันระบบ หากอยู่บนคลาวด์ Railway หรืออยู่ในโหมด Production จริง
if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
    connectionType = "Railway Cloud Database";

    db = mysql.createConnection({
        uri: process.env.DATABASE_URL,
        multipleStatements: true,
        timezone: '+07:00'
    });
} else {
    // สำหรับรันในเครื่อง Mac/Windows ผ่านเครื่องมือจำลอง XAMPP / MAMP
    connectionType = "Local XAMPP MySQL";
    console.log(`Connecting to ${connectionType}...`);

    db = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'sentang_huabaan',
        timezone: '+07:00',
        multipleStatements: true
    });
}

db.connect((err) => {
    if (err) {
        console.error(`❌ DB Connection Error (${connectionType}):`, err.message);
    } else {
        console.log(`✅ DB Connected Successfully! Running on: ${connectionType}`);
        db.query("SET time_zone = '+07:00'");
    }
});

module.exports = db;