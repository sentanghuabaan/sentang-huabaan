const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// เชื่อมต่อ Cloudinary 
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ปรับการทำงานเลือกโฟลเดอร์ไปไว้บน Cloudinary
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {

        let folderName = 'huabaan_system_pictures';

        if (req.baseUrl.includes('map') || req.path.includes('map')) {
            folderName = 'huabaan_pic_map';
        }
        else if (req.baseUrl.includes('locations') || req.path.includes('locations')) {
            folderName = 'huabaan_admin_locations';
        }
        else if (req.baseUrl.includes('location-images') || req.path.includes('location-images')) {
            folderName = 'huabaan_admin_locationimage';
        }
        else if (req.baseUrl.includes('activities') || req.path.includes('activities')) {
            folderName = 'huabaan_admin_activity';
        }
        else if (req.baseUrl.includes('activity-images') || req.path.includes('activity-images')) {
            folderName = 'huabaan_admin_activityimage';
        }
        else if (req.baseUrl.includes('history-gallery') || req.path.includes('history-gallery')) {
            folderName = 'huabaan_admin_history';
        }
        else if (req.baseUrl.includes('community-gallery') || req.path.includes('community-gallery')) {
            folderName = 'huabaan_admin_community';
        }
        else if (req.baseUrl.includes('map') || req.path.includes('map')) {
            folderName = 'huabaan_admin_map';
        }
        else if (req.baseUrl.includes('videoar') || req.path.includes('videoar')) {
            folderName = 'huabaan_videoar';
        }
        else if (
            req.baseUrl.includes('review') ||
            req.path.includes('review') ||
            req.path.includes('profile') ||
            file.fieldname === 'review_images' ||
            file.fieldname === 'profile_img'
        ) {
            folderName = 'huabaan_user_uploads';
        }

        const isVideo = file.mimetype.startsWith('video/') || file.originalname.endsWith('.mp4');

        return {
            folder: folderName,
            allowed_formats: isVideo ? ['mp4', 'mov', 'avi'] : ['jpg', 'png', 'jpeg', 'webp'],
            resource_type: isVideo ? 'video' : 'auto',
            public_id: Date.now() + '-' + file.originalname.split('.')[0]
        };
    },
});

const upload = multer({ storage: storage });
module.exports = upload;