// ============================================================
// Package Tracker Web Dashboard — Google Apps Script Backend
// Keyword-based classification (no API key required)
// ============================================================

var LOOKBACK_DAYS = 14;
var MAX_THREADS_PER_QUERY = 10; // 6 queries × 10 = up to 60 threads

/**
 * Serve the web app HTML page.
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('📦 Package Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called from the frontend to get the current user's email.
 */
function getUserEmail() {
  return Session.getActiveUser().getEmail();
}

/**
 * Main entry point: scans Gmail, classifies emails, returns package data.
 * @returns {Object} { packages: Array, scannedAt: string, emailCount: number }
 */
function scanPackages() {
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOOKBACK_DAYS);
  var afterDate = Utilities.formatDate(cutoffDate, 'UTC', 'yyyy/MM/dd');

  var queries = [
    '(from:shipment-tracking@amazon.com OR from:order-update@amazon.com OR from:auto-confirm@amazon.com) after:' + afterDate,
    '(from:no-reply@amazon.com) (subject:delivered OR subject:delivery) after:' + afterDate,
    '(from:returns@amazon.com OR from:no-reply@amazon.com) (subject:refund OR subject:return) after:' + afterDate,
    '(from:mcinfo@ups.com OR from:trackingnotify@ups.com OR from:TrackingUpdates@fedex.com OR from:USPSInformedDelivery@usps.gov OR from:auto-reply@usps.com) after:' + afterDate,
    '(subject:"has shipped" OR subject:"order shipped" OR subject:"out for delivery" OR subject:"has been delivered" OR subject:"your order is on the way") after:' + afterDate,
    '(subject:"return received" OR subject:"refund processed" OR subject:"refund issued" OR subject:"credit applied" OR subject:"return accepted" OR subject:"return confirmed") after:' + afterDate
  ];

  // Collect unique messages across all queries
  var seenIds = {};
  var emails = [];

  for (var i = 0; i < queries.length; i++) {
    try {
      var threads = GmailApp.search(queries[i], 0, MAX_THREADS_PER_QUERY);
      for (var t = 0; t < threads.length; t++) {
        var messages = threads[t].getMessages();
        // Take only the latest message per thread
        var msg = messages[messages.length - 1];
        var id = msg.getId();
        if (!seenIds[id] && msg.getDate().getTime() >= cutoffDate.getTime()) {
          seenIds[id] = true;
          emails.push({
            id: id,
            subject: msg.getSubject() || '',
            from: msg.getFrom() || '',
            date: Utilities.formatDate(msg.getDate(), 'America/Los_Angeles', 'yyyy-MM-dd'),
            body: msg.getPlainBody().substring(0, 2000)
          });
        }
      }
    } catch (err) {
      Logger.log('Query ' + i + ' failed: ' + err.message);
    }
  }

  // Classify each email into a package entry
  var packagesMap = {};

  for (var e = 0; e < emails.length; e++) {
    var pkg = classifyEmail(emails[e]);
    if (!pkg) continue;

    var key = pkg.orderNumber || pkg.trackingNumber || ('msg_' + emails[e].id);

    if (packagesMap[key]) {
      packagesMap[key] = mergePackages(packagesMap[key], pkg);
    } else {
      pkg.id = key;
      packagesMap[key] = pkg;
    }
  }

  var packageList = [];
  for (var k in packagesMap) {
    packageList.push(packagesMap[k]);
  }

  return {
    packages: packageList,
    scannedAt: new Date().toISOString(),
    emailCount: emails.length
  };
}

// ── Classification ────────────────────────────────────────────

function classifyEmail(email) {
  var subject = email.subject.toLowerCase();
  var body    = email.body.toLowerCase();
  var from    = email.from.toLowerCase();
  var full    = subject + ' ' + body;

  // Determine category (return vs delivery) — check subject first
  var isReturnEmail = /\b(return|refund|credit|send\s+back|bring\s+back)\b/.test(subject);
  if (!isReturnEmail) {
    isReturnEmail = /\b(return|refund|credit)\b/.test(body);
  }

  // Detect status — subject line is authoritative, fall back to full text
  var status;
  if (isReturnEmail) {
    status = detectReturnStatus(subject) || detectReturnStatus(full);
  } else {
    status = detectDeliveryStatus(subject) || detectDeliveryStatus(full);
  }

  if (!status) return null; // can't classify, skip

  // Re-validate category based on final status
  var category;
  if (status === 'return_initiated' || status === 'return_shipped' ||
      status === 'return_received'  || status === 'refund_issued') {
    category = 'return';
  } else {
    category = 'delivery';
  }

  var completed      = (status === 'delivered' || status === 'refund_issued');
  var orderNumber    = extractOrderNumber(full);
  var trackingNumber = extractTrackingNumber(full);
  var carrier        = detectCarrier(from, full);
  var retailer       = detectRetailer(from);
  var itemDesc       = extractItemDescription(email.subject, full);
  var estDelivery    = (category === 'delivery') ? extractEstimatedDelivery(full) : null;
  var deliveryDate   = (status === 'delivered')   ? email.date : null;
  var refundAmount   = (category === 'return')     ? extractRefundAmount(full)   : null;
  var refundDate     = (status === 'refund_issued')? email.date : null;

  return {
    id:                orderNumber || trackingNumber || ('msg_' + email.id),
    category:          category,
    status:            status,
    completed:         completed,
    itemDescription:   itemDesc,
    orderNumber:       orderNumber,
    trackingNumber:    trackingNumber,
    carrier:           carrier,
    retailer:          retailer,
    estimatedDelivery: estDelivery,
    deliveryDate:      deliveryDate,
    proofOfDeliveryUrl:null,
    refundAmount:      refundAmount,
    refundDate:        refundDate
  };
}

function detectDeliveryStatus(text) {
  // Check subject line first (more authoritative), then full text
  // IMPORTANT: delivered must come before out_for_delivery — Amazon delivery
  // confirmation emails often say "was out for delivery and has been delivered"
  if (/\b(delivered|delivery\s+complete|package\s+delivered|was\s+delivered|has\s+been\s+delivered|left\s+at\s+(your\s+)?(front\s+door|door|mailbox|porch|garage))\b/.test(text)) return 'delivered';
  if (/out\s+for\s+delivery/.test(text))                                    return 'out_for_delivery';
  if (/\b(shipped|on\s+its\s+way|on\s+the\s+way|in\s+transit|picked\s+up|dispatched|order\s+shipped|has\s+shipped)\b/.test(text)) return 'shipped';
  if (/\b(order\s+(confirmed|placed|received)|thank\s+you\s+for\s+(your\s+)?order|we('ve| have)\s+received\s+your\s+order)\b/.test(text)) return 'ordered';
  return null;
}

function detectReturnStatus(text) {
  if (/\b(refund\s+(issued|processed|approved|completed|sent)|credit\s+applied|credited|refund\s+of\s+\$|your\s+refund)\b/.test(text)) return 'refund_issued';
  if (/\b(return\s+(received|accepted|confirmed|completed)|we\s+(received|got)\s+your\s+return)\b/.test(text))                         return 'return_received';
  if (/\b(return\s+(shipped|in\s+transit|on\s+its\s+way|picked\s+up))\b/.test(text))                                                   return 'return_shipped';
  if (/\b(return\s+(initiated|started|requested|label|authorized|approved)|refund\s+request|start\s+(a\s+)?return)\b/.test(text))       return 'return_initiated';
  // Fallback: any refund/return mention
  if (/\b(refund|return)\b/.test(text)) return 'return_initiated';
  return null;
}

// ── Extraction helpers ────────────────────────────────────────

function extractOrderNumber(text) {
  // Amazon: 111-1234567-1234567
  var amazon = text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
  if (amazon) return amazon[1];

  // Generic: "order #ABC123", "order number: ABC-123"
  var generic = text.match(/order\s*(?:#|number|num|no\.?|id)?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9\-]{4,20})/i);
  if (generic) return generic[1].toUpperCase();

  return null;
}

function extractTrackingNumber(text) {
  // UPS: 1Z followed by 16 alphanumeric chars
  var ups = text.match(/\b(1Z[A-Z0-9]{16})\b/i);
  if (ups) return ups[1].toUpperCase();

  // USPS: 9400/9205/9261/9274 + 18 digits
  var usps = text.match(/\b(9[24][0-9]{20})\b/);
  if (usps) return usps[1];

  // FedEx: 12 or 15 or 20 digits starting with specific prefixes
  var fedex = text.match(/\b([0-9]{12,14})\b/);
  if (fedex) return fedex[1];

  // Amazon TBA
  var tba = text.match(/\b(TBA\d{12,})\b/i);
  if (tba) return tba[1].toUpperCase();

  return null;
}

function detectCarrier(from, text) {
  if (/amazon/.test(from) || /amazon/.test(text.substring(0, 100))) return 'Amazon';
  if (/ups\.com/.test(from) || /\bups\b/.test(text.substring(0, 200)))     return 'UPS';
  if (/fedex/.test(from)    || /fedex/.test(text.substring(0, 200)))       return 'FedEx';
  if (/usps/.test(from)     || /usps/.test(text.substring(0, 200)))        return 'USPS';
  if (/dhl/.test(from)      || /\bdhl\b/.test(text.substring(0, 200)))     return 'DHL';
  return 'Carrier';
}

function detectRetailer(from) {
  var domain = from.match(/@([\w.-]+)/);
  if (!domain) return 'Unknown';
  var d = domain[1].toLowerCase();
  if (/amazon/.test(d))  return 'Amazon';
  if (/bestbuy/.test(d)) return 'Best Buy';
  if (/target/.test(d))  return 'Target';
  if (/walmart/.test(d)) return 'Walmart';
  if (/costco/.test(d))  return 'Costco';
  if (/ebay/.test(d))    return 'eBay';
  if (/apple/.test(d))   return 'Apple';
  if (/ups/.test(d))     return 'UPS';
  if (/fedex/.test(d))   return 'FedEx';
  if (/usps/.test(d))    return 'USPS';
  // Capitalize first part of domain as retailer name
  var parts = d.replace(/\.(com|net|org|io)$/, '').split('.');
  return parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1);
}

function extractItemDescription(subject, fullText) {
  // Try to strip common prefixes from subject line
  var s = subject
    .replace(/^your\s+(amazon\.?com\s+)?order\s+(of\s+)?/i, '')
    .replace(/^(order\s+(confirmed|shipped|delivered|update)|shipment\s+(notification|update|confirmation))\s*[-:]\s*/i, '')
    .replace(/^(your\s+)?(package|shipment)\s+(has\s+)?(shipped|delivered|is\s+on\s+its\s+way|out\s+for\s+delivery)\s*[-:]?\s*/i, '')
    .replace(/^(your\s+)?return\s+(for\s+|of\s+)?/i, '')
    .replace(/\s+has\s+(shipped|been\s+delivered|been\s+received).*$/i, '')
    .trim();

  // If subject is too generic or empty, fall back to a generic label
  if (!s || s.length < 3 || /^(re:|fwd:|notification|update|alert|confirmation)$/i.test(s)) {
    return 'Package';
  }

  // Capitalize first letter
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractEstimatedDelivery(text) {
  // "arriving Monday, April 5" / "by April 5" / "estimated delivery: April 5"
  var patterns = [
    /arriving\s+(?:by\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?,?\s*([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /(?:estimated\s+)?(?:delivery|arrival)\s*(?:date)?[:\s]+(?:by\s+)?([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /(?:by|before)\s+((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+[a-z]+\s+\d{1,2})/i,
    /deliver(?:ed|y)\s+by\s+([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m) {
      // Try to parse and normalize the date
      try {
        var d = new Date(m[1]);
        if (!isNaN(d.getTime())) {
          return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
        }
      } catch (e) {}
      return m[1]; // return raw string if parsing fails
    }
  }
  return null;
}

function extractRefundAmount(text) {
  var m = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (m) return m[1].replace(/,/g, '');
  return null;
}

// ── Merge duplicates ──────────────────────────────────────────

var STATUS_RANK = {
  'ordered': 1, 'shipped': 2, 'out_for_delivery': 3, 'delivered': 4,
  'return_initiated': 1, 'return_shipped': 2, 'return_received': 3, 'refund_issued': 4
};

function mergePackages(existing, incoming) {
  var rankE = STATUS_RANK[existing.status] || 0;
  var rankI = STATUS_RANK[incoming.status] || 0;
  // Keep the higher-status entry as the base, fill in missing fields
  var base  = (rankI > rankE) ? incoming : existing;
  var other = (rankI > rankE) ? existing  : incoming;

  return {
    id:                base.id,
    category:          base.category,
    status:            base.status,
    completed:         base.completed,
    itemDescription:   base.itemDescription || other.itemDescription,
    orderNumber:       base.orderNumber    || other.orderNumber,
    trackingNumber:    base.trackingNumber || other.trackingNumber,
    carrier:           base.carrier        || other.carrier,
    retailer:          base.retailer       || other.retailer,
    estimatedDelivery: base.estimatedDelivery || other.estimatedDelivery,
    deliveryDate:      base.deliveryDate   || other.deliveryDate,
    proofOfDeliveryUrl:base.proofOfDeliveryUrl || other.proofOfDeliveryUrl,
    refundAmount:      base.refundAmount   || other.refundAmount,
    refundDate:        base.refundDate     || other.refundDate
  };
}
