const https = require('https');
const { URL } = require('url');

const KEYWORDS = ['Odoo', 'Odoo ERP', 'Odoo Bookkeeping', 'Odoo Shopify', 'Odoo Automation'];
const MIN_BUDGET = 500;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

const fetchUrl = (url) => {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };
    const request = https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy());
  });
};

const scrapeUpworkJobs = async () => {
  const jobs = [];
  for (const keyword of KEYWORDS) {
    try {
      const searchUrl = `https://www.upwork.com/nx/jobs/search/?q=${encodeURIComponent(keyword)}&sort=posted_on&limit=50`;
      console.log(`Scraping: ${keyword}`);
      const html = await fetchUrl(searchUrl);
      const jobPattern = /"id":"(\d+)","title":"([^"]+)".*?"budgetAmount":(\d+(?:\.\d+)?).*?"clientRating":([\d.]+)?/g;
      let match;
      while ((match = jobPattern.exec(html)) !== null) {
        const jobId = match[1];
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
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error scraping ${keyword}:`, error.message);
    }
  }
  return jobs;
};

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
        'Content-Type': 'application/json'
      }
    };
    const request = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    request.on('error', reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
};

const main = async () => {
  console.log('Starting Upwork job scraper...');
  try {
    const jobs = await scrapeUpworkJobs();
    console.log(`Found ${jobs.length} jobs`);
    for (const job of jobs) {
      try {
        await sendSlackNotification(job);
        console.log(`Notified: ${job.title}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error: ${error.message}`);
      }
    }
    console.log('Complete');
  } catch (error) {
    console.error('Fatal error:', error);
  }
};

main();

// Run every 5 minutes (300000 ms)
setInterval(main, 300000);
