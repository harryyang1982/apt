import express from 'express';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const app = express();
const PORT = process.env.PORT || 3000;

// Custom .env key parser to handle multiple sections like [APT] and [kakao]
function getApiKeys() {
  const keys = { apt: '', kakaoJs: '', kakaoRest: '', githubToken: '', githubOwner: '', githubRepo: '' };
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      let currentSection = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          currentSection = trimmed.slice(1, -1).toLowerCase();
          continue;
        }
        const match = line.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*["']?([^"']+)["']?/);
        if (match) {
          const keyName = match[1].trim().toLowerCase();
          const val = match[2].trim();
          if (currentSection === 'apt' && keyName === 'key') {
            keys.apt = val;
          } else if (currentSection === 'kakao') {
            if (keyName === 'js_key' || keyName === 'js') {
              keys.kakaoJs = val;
            } else if (keyName === 'rest_api_key' || keyName === 'rest') {
              keys.kakaoRest = val;
            } else if (keyName === 'key') {
              keys.kakaoJs = val; // fallback for general key
            }
          } else if (currentSection === 'github') {
            if (keyName === 'token' || keyName === 'key') {
              keys.githubToken = val;
            } else if (keyName === 'owner' || keyName === 'username') {
              keys.githubOwner = val;
            } else if (keyName === 'repo') {
              keys.githubRepo = val;
            }
          }
        }
      }
      if (keys.githubToken && !keys.githubRepo) {
        keys.githubRepo = 'apt';
      }
    }
  } catch (e) {
    console.error("Error reading API keys from .env:", e);
  }
  return keys;
}

const API_KEYS = getApiKeys();
const API_KEY = API_KEYS.apt;
const KAKAO_KEY = API_KEYS.kakaoJs || API_KEYS.kakaoRest;

if (!API_KEY) {
  console.warn("WARNING: APT API Key not found in .env. API calls will fail.");
} else {
  console.log("Successfully loaded APT API Key (ends with ... " + API_KEY.slice(-6) + ")");
}

if (!KAKAO_KEY) {
  console.warn("WARNING: Kakao API Key not found in .env. Kakao Maps will not load.");
} else {
  const keyType = API_KEYS.kakaoJs ? "JS Key" : "REST Key";
  console.log(`Successfully loaded Kakao API Key (${keyType}, ends with ... ${KAKAO_KEY.slice(-6)})`);
}

if (API_KEYS.githubToken) {
  console.log(`Successfully loaded GitHub config for ${API_KEYS.githubOwner}/${API_KEYS.githubRepo}`);
}

// Serve static files from the 'public' directory
app.use(express.static(path.join(process.cwd(), 'public')));

// Serve sigungu.json directly from root if requested
app.get('/sigungu.json', (req, res) => {
  const filePath = path.join(process.cwd(), 'sigungu.json');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'sigungu.json file not found' });
  }
});

// Endpoint to serve Kakao API config to the frontend
app.get('/api/config', (req, res) => {
  res.json({
    kakaoKey: KAKAO_KEY || ''
  });
});

// Endpoint to serve GitHub config from .env
app.get('/api/github/config', (req, res) => {
  res.json({
    token: API_KEYS.githubToken || '',
    owner: API_KEYS.githubOwner || '',
    repo: API_KEYS.githubRepo || ''
  });
});

// Proxy endpoint to search apartment transactions
app.get('/api/transactions', async (req, res) => {
  const { lawdCd, dealYmd } = req.query;

  if (!lawdCd || !dealYmd) {
    return res.status(400).json({ error: 'Missing required parameters: lawdCd and dealYmd are required.' });
  }

  if (!API_KEY) {
    return res.status(500).json({ error: 'API Key is not configured on the server.' });
  }

  try {
    const url = 'http://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';
    console.log(`Requesting MOLIT API for region: ${lawdCd}, month: ${dealYmd}`);
    
    const response = await axios.get(url, {
      params: {
        serviceKey: API_KEY,
        LAWD_CD: lawdCd,
        DEAL_YMD: dealYmd,
        numOfRows: 1500, // Maximum allowed rows to fetch all transactions
        pageNo: 1
      },
      headers: {
        'Accept': 'application/xml'
      },
      timeout: 10000 // 10s timeout
    });

    const parser = new XMLParser({
      ignoreAttributes: false,
      trimValues: true
    });
    
    const jsonObj = parser.parse(response.data);
    
    // Check API response structure
    const header = jsonObj?.response?.header;
    const resCode = header && header.resultCode !== undefined ? String(header.resultCode) : '';
    if (header && resCode !== '00' && resCode !== '000' && resCode !== '0') {
      return res.status(500).json({ 
        error: `Public API Error: ${header.resultMsg || 'Unknown error code: ' + header.resultCode}` 
      });
    }

    const body = jsonObj?.response?.body;
    const itemsObj = body?.items;
    let items = [];
    
    if (itemsObj && itemsObj.item) {
      if (Array.isArray(itemsObj.item)) {
        items = itemsObj.item;
      } else {
        items = [itemsObj.item];
      }
    }

    // Clean and normalize items
    const transactions = items.map(item => {
      // Parse amount (comes as a string with commas, e.g. "101,300")
      let dealAmountRaw = item.dealAmount || '0';
      let dealAmount = parseInt(dealAmountRaw.replace(/,/g, '').trim(), 10) || 0;

      // Extract details
      const aptDong = item.umdNm ? String(item.umdNm).trim() : '';
      const dongBuilding = item.aptDong ? String(item.aptDong).trim() : '';
      const aptNm = item.aptNm ? String(item.aptNm).trim() : '';
      const buildYear = parseInt(item.buildYear, 10) || null;
      const dealYear = parseInt(item.dealYear, 10);
      const dealMonth = parseInt(item.dealMonth, 10);
      const dealDay = parseInt(item.dealDay, 10);
      const excluUseAr = parseFloat(item.excluUseAr) || 0;
      const floor = parseInt(item.floor, 10) || null;
      const jibun = item.jibun ? String(item.jibun).trim() : '';
      
      // Cancellation check
      const cdealDay = item.cdealDay ? String(item.cdealDay).trim() : '';
      const cdealType = item.cdealType ? String(item.cdealType).trim() : '';
      const isCancelled = !!cdealDay;

      // Format date
      const monthStr = String(dealMonth).padStart(2, '0');
      const dayStr = String(dealDay).padStart(2, '0');
      const dealDate = `${dealYear}-${monthStr}-${dayStr}`;

      return {
        aptNm,
        aptDong,
        dongBuilding,
        buildYear,
        dealAmount, // in ten-thousand KRW (만원)
        dealDate,
        dealYear,
        dealMonth,
        dealDay,
        excluUseAr,
        floor,
        jibun,
        isCancelled,
        cdealDate: isCancelled ? `${dealYear}-${String(dealMonth).padStart(2, '0')}-${cdealDay.padStart(2, '0')}` : null,
        cdealType
      };
    });

    res.json({
      total: transactions.length,
      transactions: transactions
    });

  } catch (error) {
    console.error('Proxy request error:', error.message);
    if (error.response) {
      // The API responded with non-2xx code
      res.status(error.response.status).json({ 
        error: `MOLIT API Error: ${error.message}`, 
        details: error.response.data 
      });
    } else {
      res.status(500).json({ error: `Server Proxy Error: ${error.message}` });
    }
  }
});

// Run server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
