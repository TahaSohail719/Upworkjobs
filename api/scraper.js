const https = require('https');
const { URL } = require('url');

// ============ CONFIGURATION ============
const KEYWORDS = ['Odoo', 'Odoo ERP', 'Odoo Bookkeeping', 'Odoo Shopify', 'Odoo Automation'];
const MIN_BUDGET = 500;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

// ============ FETCH URL WITH BETTER HEADERS ============
const fetchUrl = (url) => {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      timeout: 15000
    };

    const request = https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy());
  });
};

// ============ SCRAPE UPWORK JOBS ============
const scrapeUpworkJobs = async () => {
  const jobs = [];
  const seenJobIds = new Set();

  for (const keyword of KEYWORDS) {
    try {
      const searchUrl = `https://www.upwork.com/nx/jobs/search/?q=${encodeURIComponent(keyword)}&sort=posted_on&limit=50`;
      console.log(`[${new Date().toISOString()}] Scraping: ${keyword}`);
      
      const html = await fetchUrl(searchUrl);

      // Multiple regex patterns to catch different Upwork HTML structures
      const patterns = [
        /"id":"(\d+)","title":"([^"]+)".*?"budgetAmount":(\d+(?:\.\d+)?).*?"clientRating":([\d.]+)?/g,
        /"jobId":"(\d+)","title":"([^"]+)".*?"budget":(\d+(?:\.\d+)?).*?"rating":([\d.]+)?/g,
        /"(\d+)"\s*:\s*\{\s*"title"\s*:\s*"([^"]+)".*?"budget"\s*:\s*(\d+(?:\.\d+)?)/g
      ];

      let foundJobsForKeyword = 0;

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const jobId = match[1];
          
          // Skip if we've already seen this job
          if (seenJobIds.has(jobId)) {
            continue;
          }

          const title = match[2];
          const budget = parseFloat(match[3]);
          const clientRating = match[4] ? parseFloat(match[4]) : 0;

          if (budget >= MIN_BUDGET) {
            jobs.push({
              id: jobId,
              title: title,
              budget: budget,
              url: `https://www.upwork.com/jobs/${jobId}`,
              client_rating: clientRating,
              category: keyword
            });
            seenJobIds.add(jobId);
            foundJobsForKeyword++;
          }
        }
      }

      if (foundJobsForKeyword === 0) {
        console.log(`[${new Date().toISOString()}] No jobs found for: ${keyword}`);
      } else {
        console.log(`[${new Date().toISOString()}] Found ${foundJobsForKeyword} jobs for: ${keyword}`);
      }

      // Wait 5 seconds between searches to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 5000));

    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error scraping ${keyword}:`, error.message);
    }
  }

  console.log(`[${new Date().toISOString()}] Total jobs found: ${jobs.length}`);
  return jobs;
};

// ============ SEND SLACK NOTIFICATION ============
const sendSlackNotification = async (job) => {
  const payload = {
    channel: '#upwork-jobs',
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🔔 NEW UPWORK JOB',
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Job Title*\n${job.title}`
          },
          {
            type: 'mrkdwn',
            text: `*Budget*\n$${Math.round(job.budget)} USD`
          },
          {
            type: 'mrkdwn',
            text: `*Client Rating*\n${job.client_rating > 0 ? job.client_rating.toFixed(1) : 'New'} ⭐`
          },
          {
            type: 'mrkdwn',
            text: `*Category*\n${job.category}`
          }
        ]
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔗 View Job',
              emoji: true
            },
            url: job.url,
            style: 'primary'
          }
        ]
      },
      {
        type: 'divider'
      }
    ]
  };

  return new Promise((resolve, reject) => {
    const url = new URL(SLACK_WEBHOOK);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload))
      },
      timeout: 10000
    };

    const request = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Slack returned status ${res.statusCode}`));
        }
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Slack request timeout'));
    });

    request.write(JSON.stringify(payload));
    request.end();
  });
};

// ============ MAIN FUNCTION ============
const main = async () => {
  console.log(`[${new Date().toISOString()}] ===== STARTING UPWORK JOB SCRAPER =====`);
  
  try {
    const jobs = await scrapeUpworkJobs();
    console.log(`[${new Date().toISOString()}] Total jobs to notify: ${jobs.length}`);

    let notifiedCount = 0;

    for (const job of jobs) {
      try {
        await sendSlackNotification(job);
        notifiedCount++;
        console.log(`[${new Date().toISOString()}] ✓ Notified: ${job.title}`);
        
        // Wait 1 second between Slack notifications
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`[${new Date().toISOString()}] ✗ Error notifying job ${job.id}:`, error.message);
      }
    }

    console.log(`[${new Date().toISOString()}] ===== SCRAPING COMPLETE =====`);
    console.log(`[${new Date().toISOString()}] Summary: Found ${jobs.length} jobs, notified ${notifiedCount} jobs`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] FATAL ERROR:`, error.message);
  }
};

// ============ RUN SCRAPER ============
main();

// Run every 5 minutes (300000 milliseconds)
setInterval(main, 300000);

console.log(`[${new Date().toISOString()}] Scraper scheduled to run every 5 minutes`);
