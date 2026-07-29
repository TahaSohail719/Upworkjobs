// api/scraper.js - Vercel serverless function

const https = require('https');
const { URL } = require('url');

const KEYWORDS = ['Odoo', 'ERP', 'Shopify', 'Automation', 'Bookkeeping'];
const MIN_BUDGET = 500;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

// Simple in-memory cache for seen jobs (reset on function restart)
// For production, use a proper database
const seenJobs = new Set();

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

      // Parse job data from HTML - looking for job ID and title patterns
      const jobPattern = /"id":"(\d+)","title":"([^"]+)".*?"budgetAmount":(\d+(?:\.\d+)?).*?"clientRating":([\d.]+)?/g;
      
      let match;
      while ((match = jobPattern.exec(html)) !== null) {
        const jobId = match[1];
        const title = match[2];
        const budget = parseFloat(match[3]);
        const clientRating = match[4] ? parseFloat(match[4]) : 0;

        if (budget >= MIN_BUDGET && !seenJobs.has(jobId)) {
          jobs.push({
            id: jobId,
            title: title,
            budget: budget,
            url: `https://www.upwork.com/jobs/${jobId}`,
            client_rating: clientRating,
            category: keyword
          });
          
          seenJobs.add(jobId);
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
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '📋 Generate Proposal',
              emoji: true
            },
            url: `${process.env.PROPOSAL_GENERATOR_URL}?job=${encodeURIComponent(job.title)}`
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

export default async (req, res) => {
  // Verify the request is from Vercel Cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const jobs = await scrapeUpworkJobs();
    console.log(`Found ${jobs.length} new jobs`);

    let notifiedCount = 0;
    for (const job of jobs) {
      try {
        await sendSlackNotification(job);
        notifiedCount++;
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Failed to notify job ${job.id}:`, error);
      }
    }

    res.status(200).json({
      success: true,
      totalFound: jobs.length,
      notified: notifiedCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Scraper error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
