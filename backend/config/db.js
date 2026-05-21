const path = require('path');
const mysql = require('mysql2');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

let pool;
let connectionType = "";

const dbConfig = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+07:00',
    multipleStatements: true,

    waitForConnections: true,
    connectionLimit: 15,      
    queueLimit: 0,
    enableKeepAlive: true,    
    keepAliveInitialDelay: 10000,
    
    ssl: {
        rejectUnauthorized: false
    }
};
if (process.env.PORT && process.env.PORT !== '3000') {
    connectionType = "Aiven MySQL Cloud (Production)";
    console.log(`🚀 Server ตัวจริงกำลังเชื่อมต่อไปยัง: ${connectionType}`);
    pool = mysql.createPool(dbConfig); 
} else {
    connectionType = "Aiven MySQL Cloud (Local Test)";
    console.log(`💻 เครื่องคอม Local กำลังเชื่อมต่อไปยัง: ${connectionType}`);
    pool = mysql.createPool(dbConfig); 
}

pool.getConnection((err, connection) => {
    if (err) {
        console.error(`❌ DB Connection Pool Error (${connectionType}):`, err.message);
        console.log("⚠️ ระบบเปิดสิทธิ์ Bypass ชั่วคราวเพื่อให้เว็บเปิดหน้าโครงสร้างได้ต่อ");
    } else {
        console.log(`✅ DB Connected Successfully via Pool! Running on: ${connectionType}`);
        
        connection.query(`SET SESSION sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))`, (modeErr) => {
            if (modeErr) console.error("❌ ไม่สามารถปรับ sql_mode ได้:", modeErr.message);
        });

        connection.query("SET time_zone = '+07:00'");
        connection.release(); 
    }
});

module.exports = pool;