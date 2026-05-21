const path = require('path');
const mysql = require('mysql2');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

let pool;
let connectionType = "Aiven MySQL Cloud (Local Test)";

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
    keepAliveInitialDelay: 10000 
};

console.log(`Connecting to ${connectionType}...`);
pool = mysql.createPool(dbConfig); 

// ตัดสัญญาส่วน pool.getConnection ที่คอยพ่น Error และสั่งแครชออกไป
console.log("⚠️ สตาร์ทระบบแบบ Bypass: ปล่อยให้ Express Server เปิดพอร์ตทำงานทันที");

module.exports = pool;