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
    '(subject:"return received" OR subject:"refund processed" OR subject:"refund issued" OR subject:"credit applied" OR subject:"return accepted" OR subject:"return confirmed") after:' + afterDate,
    '(subject:"order confirmed" OR subject:"order confirmation" OR subject:"order received" OR subject:"order placed" OR subject:"thank you for your order" OR subject:"thanks for your order" OR subject:"thanks for your purchase") after:' + afterDate
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
          // Normalize whitespace before truncating so 4000 chars = more signal
          var rawBody = msg.getPlainBody() || '';
          var cleanBody = rawBody.replace(/\n{3,}/g, '\n\n').trim().substring(0, 4000);
          emails.push({
            id: id,
            subject: msg.getSubject() || '',
            from: msg.getFrom() || '',
            date: Utilities.formatDate(msg.getDate(), 'America/Los_Angeles', 'yyyy-MM-dd'),
            body: cleanBody
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
  var itemDesc       = extractItemDescription(email.subject, email.body);
  var estDelivery    = (category === 'delivery') ? extractEstimatedDelivery(full) : null;
  var deliveryDate   = (status === 'delivered')    ? email.date : null;
  var refundAmount   = (category === 'return')      ? extractRefundAmount(full)  : null;
  var refundDate     = (status === 'refund_issued') ? email.date : null;
  var trackingUrl    = buildTrackingUrl(carrier, trackingNumber, orderNumber);

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
    refundDate:        refundDate,
    trackingUrl:       trackingUrl
  };
}

function detectDeliveryStatus(text) {
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

  // FedEx: 12-20 digits (avoid matching order numbers)
  var fedex = text.match(/\btracking\s*(?:#|number|no\.?|id)?[:\s]+([0-9]{12,20})\b/i);
  if (fedex) return fedex[1];

  // Amazon TBA
  var tba = text.match(/\b(TBA\d{12,})\b/i);
  if (tba) return tba[1].toUpperCase();

  return null;
}

function detectCarrier(from, text) {
  if (/amazon/.test(from))              return 'Amazon';
  if (/ups\.com/.test(from) || /\bups\b/.test(text.substring(0, 300)))   return 'UPS';
  if (/fedex/.test(from)    || /fedex/.test(text.substring(0, 300)))     return 'FedEx';
  if (/usps/.test(from)     || /\busps\b/.test(text.substring(0, 300)))  return 'USPS';
  if (/dhl/.test(from)      || /\bdhl\b/.test(text.substring(0, 300)))   return 'DHL';
  if (/amazon/.test(text.substring(0, 100)))                             return 'Amazon';
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
  var parts = d.replace(/\.(com|net|org|io|co)$/, '').split('.');
  return parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1);
}

/**
 * Extract the actual product name from an email.
 * Priority: quoted text in subject → Amazon body pattern → generic body patterns → cleaned subject
 */
function extractItemDescription(subject, body) {
  // 1. Quoted text in subject: Your order of "Product Name" has shipped
  var quoted = subject.match(/["""]([^"""]{8,80})["""]/);
  if (quoted) return quoted[1].trim();

  // Also try straight quotes
  var straightQuoted = subject.match(/"([^"]{8,80})"/);
  if (straightQuoted) return straightQuoted[1].trim();

  // 2. Amazon body pattern: "1 of: Product Name"
  var amazonItem = body.match(/\d+\s+of:\s*([^\n\r]{5,80})/i);
  if (amazonItem) return amazonItem[1].trim();

  // 3. Generic body item patterns (tried in order)
  var bodyPatterns = [
    /^item(?:s)?:\s*([^\n\r]{5,80})/im,
    /^product(?:s)?:\s*([^\n\r]{5,80})/im,
    /^description:\s*([^\n\r]{5,80})/im,
    /you\s+ordered:\s*([^\n\r]{5,80})/i,
    /(?:ordered|purchased|bought):\s*["']?([^\n\r"']{5,80})/i,
    /item\s+(?:name|ordered|description):\s*([^\n\r]{5,80})/i
  ];

  for (var i = 0; i < bodyPatterns.length; i++) {
    var m = body.match(bodyPatterns[i]);
    if (m) return m[1].trim();
  }

  // 4. Cleaned subject fallback — strip status/shipping boilerplate
  var s = subject
    .replace(/^your\s+(amazon\.?com\s+)?order\s+(of\s+)?/i, '')
    .replace(/^(order\s+(confirmed|shipped|delivered|update)|shipment\s+(notification|update|confirmation))\s*[-:]\s*/i, '')
    .replace(/^(your\s+)?(package|shipment)\s+(has\s+)?(shipped|delivered|is\s+on\s+its\s+way|out\s+for\s+delivery)\s*[-:]?\s*/i, '')
    .replace(/^(your\s+)?return\s+(for\s+|of\s+)?/i, '')
    .replace(/\s+has\s+(shipped|been\s+delivered|been\s+received).*$/i, '')
    .replace(/\s+is\s+(out\s+for\s+delivery|on\s+its\s+way|on\s+the\s+way).*$/i, '')
    .trim();

  if (s && s.length >= 5 && !/^(re:|fwd:|notification|update|alert|confirmation|shipped|delivered|order)$/i.test(s)) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // 5. Last resort
  return 'Package';
}

/**
 * Build a carrier tracking URL from available identifiers.
 */
function buildTrackingUrl(carrier, trackingNumber, orderNumber) {
  if (trackingNumber) {
    var tn = trackingNumber.toUpperCase();
    if (/^1Z/.test(tn)) {
      return 'https://www.ups.com/track?tracknum=' + tn;
    }
    if (/^9[24]/.test(tn)) {
      return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + tn;
    }
    if (/^TBA/.test(tn) && orderNumber) {
      return 'https://www.amazon.com/progress-tracker/package?_encoding=UTF8&orderId=' + encodeURIComponent(orderNumber);
    }
    if (carrier === 'FedEx') {
      return 'https://www.fedex.com/fedextrack/?trknbr=' + tn;
    }
    if (carrier === 'DHL') {
      return 'https://www.dhl.com/en/express/tracking.html?AWB=' + tn;
    }
  }
  // Fall back to Amazon order page for Amazon orders
  if (orderNumber && /^\d{3}-\d{7}-\d{7}$/.test(orderNumber)) {
    return 'https://www.amazon.com/gp/your-account/order-details?orderID=' + encodeURIComponent(orderNumber);
  }
  return null;
}

function extractEstimatedDelivery(text) {
  var patterns = [
    /arriving\s+(?:by\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?,?\s*([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /(?:estimated\s+)?(?:delivery|arrival)\s*(?:date)?[:\s]+(?:by\s+)?([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /(?:by|before)\s+((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+[a-z]+\s+\d{1,2})/i,
    /deliver(?:ed|y)\s+by\s+([a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m) {
      try {
        var d = new Date(m[1]);
        if (!isNaN(d.getTime())) {
          return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
        }
      } catch (e) {}
      return m[1];
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
  var base  = (rankI > rankE) ? incoming : existing;
  var other = (rankI > rankE) ? existing  : incoming;

  // Prefer item descriptions that look like real product names (longer, not generic)
  var bestDesc = pickBestDescription(base.itemDescription, other.itemDescription);

  return {
    id:                base.id,
    category:          base.category,
    status:            base.status,
    completed:         base.completed,
    itemDescription:   bestDesc,
    orderNumber:       base.orderNumber    || other.orderNumber,
    trackingNumber:    base.trackingNumber || other.trackingNumber,
    carrier:           base.carrier        || other.carrier,
    retailer:          base.retailer       || other.retailer,
    estimatedDelivery: base.estimatedDelivery || other.estimatedDelivery,
    deliveryDate:      base.deliveryDate   || other.deliveryDate,
    proofOfDeliveryUrl:base.proofOfDeliveryUrl || other.proofOfDeliveryUrl,
    refundAmount:      base.refundAmount   || other.refundAmount,
    refundDate:        base.refundDate     || other.refundDate,
    trackingUrl:       base.trackingUrl    || other.trackingUrl
  };
}

/**
 * Pick the more descriptive item name between two candidates.
 * Prefers longer strings that aren't generic fallbacks.
 */
function pickBestDescription(a, b) {
  var generic = /^(package|shipment|item|order|delivery)$/i;
  var aIsGeneric = !a || generic.test(a.trim());
  var bIsGeneric = !b || generic.test(b.trim());
  if (aIsGeneric && !bIsGeneric) return b;
  if (!aIsGeneric && bIsGeneric) return a;
  // Both real: pick the longer one (more detail)
  return (!b || (a && a.length >= b.length)) ? a : b;
}
