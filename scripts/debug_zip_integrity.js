
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function testZipIntegrity() {
    const url = 'https://subsunacs.net/get.php?id=159283';
    const tmpDir = path.join(__dirname, '..', 'tmp');
    const filePath = path.join(tmpDir, 'problematic.zip');

    console.log(`[Debug] Downloading ${url}`);

    try {
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
            console.log(`[Debug] Created directory: ${tmpDir}`);
        }

        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://subsunacs.net/'
            }
        });

        const buffer = Buffer.from(response.data);
        fs.writeFileSync(filePath, buffer);
        console.log(`[Debug] Saved ${buffer.length} bytes to ${filePath}`);
        console.log('[Debug] File saved successfully. Now testing integrity...');

    } catch (error) {
        console.error(`[Debug] Error during download: ${error.message}`);
    }
}

testZipIntegrity();
