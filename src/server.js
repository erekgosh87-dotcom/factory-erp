const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { create } = require('xmlbuilder2');
const { PrismaClient } = require('@prisma/client');

/*
 * Factory ERP Server
 *
 * This server implements a minimal ERP for a textile/quilting factory.
 * It demonstrates key concepts such as password‑only authentication, IP
 * logging, branch separation, production management, labour payments,
 * inventory and simple Tally export/import. Every button exposed in the UI
 * triggers a real API call which writes to the database and audit log.
 *
 * WARNING: This implementation is intentionally simplified for
 * demonstration purposes. Before using in production you must add a
 * proper user system, secure password hashing, data validation and
 * permission checks. The password is hardcoded as 'admin123'.
 */

const app = express();
const prisma = new PrismaClient();

// Configuration
const JWT_SECRET = 'REPLACE_ME_WITH_A_SECURE_SECRET';
const REFRESH_SECRET = 'REPLACE_ME_WITH_ANOTHER_SECRET';
const LOGIN_PASSWORD = 'admin123';

// Path for login IP log file
const DATA_DIR = path.join(__dirname, '../data');
const LOGIN_IP_FILE = path.join(DATA_DIR, 'loginip');
const TALLY_OUTBOX_DIR = path.join(__dirname, '../integrations/tally/outbox');
const TALLY_INBOX_DIR = path.join(__dirname, '../integrations/tally/inbox');

// Ensure required directories exist
function ensureDirectories() {
  [DATA_DIR, TALLY_OUTBOX_DIR, TALLY_INBOX_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  // Ensure loginip file exists
  if (!fs.existsSync(LOGIN_IP_FILE)) {
    fs.writeFileSync(LOGIN_IP_FILE, '');
  }
}

// Initialise sample data when the application is first run
async function initDatabase() {
  // Create a default branch if none exists
  const branches = await prisma.branch.findMany();
  if (branches.length === 0) {
    const branch = await prisma.branch.create({
      data: { name: 'Main Branch' }
    });
    // Create departments for the branch
    const defaultDepartments = [
      'Tafta Quilting',
      'Embroidery Quilting',
      'Paper Quilting',
      'Jacket Filling',
      'Gun Filling',
      'Sampling & Cutting'
    ];
    for (const name of defaultDepartments) {
      await prisma.department.create({
        data: { name, branchId: branch.id }
      });
    }
    // Create a few machines for demonstration
    const departments = await prisma.department.findMany();
    for (const dept of departments) {
      await prisma.machine.create({
        data: { name: `${dept.name} Machine 1`, departmentId: dept.id, branchId: branch.id }
      });
    }
  }
}

// Write login information to file
async function appendLoginIp({ ip, userAgent, success }) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} | ${ip} | ${userAgent} | ${success ? 'SUCCESS' : 'FAIL'}\n`;
  // Use appendFileSync to ensure atomic append
  fs.appendFileSync(LOGIN_IP_FILE, line);
}

// Record login event in database
async function recordLoginHistory({ ip, userAgent, success }) {
  await prisma.loginHistory.create({
    data: { ip, userAgent, success }
  });
}

// Create a new user session and corresponding refresh token
async function createSession({ ip, userAgent, branchId }) {
  const sessionId = uuidv4();
  const refreshToken = uuidv4();
  // Set expiry for 7 days on refresh token
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await prisma.userSession.create({
    data: { sessionId, userAgent, ip, refreshToken, expiresAt, branchId }
  });
  return { session, refreshToken };
}

// Generate a JWT access token for a session
function generateAccessToken(session) {
  return jwt.sign({ sessionId: session.sessionId }, JWT_SECRET, { expiresIn: '1h' });
}

// Generate a JWT refresh token for a session
function generateRefreshToken(session, refreshToken) {
  return jwt.sign({ sessionId: session.sessionId, token: refreshToken }, REFRESH_SECRET, { expiresIn: '7d' });
}

// Middleware to verify access token and set req.sessionInfo
async function authMiddleware(req, res, next) {
  const token = req.cookies['accessToken'];
  if (!token) {
    return res.redirect('/login');
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const session = await prisma.userSession.findFirst({ where: { sessionId: payload.sessionId } });
    if (!session) {
      return res.redirect('/login');
    }
    // Attach session info and branch
    req.sessionInfo = session;
    req.branchId = session.branchId;
    next();
  } catch (err) {
    console.error('Access token verification failed', err);
    return res.redirect('/login');
  }
}

// Middleware to record IP and branch on each request
function requestLogger(req, res, next) {
  if (req.sessionInfo) {
    // Append IP and branch to audit context if needed
  }
  next();
}

// Audit logging helper
async function logAudit({ branchId, sessionId, ip, action, entity, entityId, before, after }) {
  await prisma.auditLog.create({
    data: {
      branchId,
      sessionId,
      ip,
      action,
      entity,
      entityId,
      before,
      after
    }
  });
}

// Convert invoice data into a simple Tally import XML string
function buildTallyVoucherXML({ vouchers, voucherType }) {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('ENVELOPE');
  root.ele('HEADER').ele('TALLYREQUEST').txt('Import').up().up();
  const body = root.ele('BODY').ele('IMPORTDATA');
  const reqDesc = body.ele('REQUESTDESC');
  reqDesc.ele('REPORTNAME').txt('Vouchers');
  const reqData = body.ele('REQUESTDATA');
  for (const voucher of vouchers) {
    const tallyMsg = reqData.ele('TALLYMESSAGE');
    const vch = tallyMsg.ele('VOUCHER', { VCHTYPE: voucherType, ACTION: 'Create' });
    vch.ele('DATE').txt(voucher.date);
    vch.ele('VOUCHERTYPENAME').txt(voucherType);
    vch.ele('REFERENCE').txt(voucher.reference || '');
    vch.ele('NARRATION').txt(voucher.narration || '');
    // Ledger entries
    for (const entry of voucher.entries) {
      const ledger = vch.ele('ALLLEDGERENTRIES.LIST');
      ledger.ele('LEDGERNAME').txt(entry.ledgerName);
      ledger.ele(entry.isDebit ? 'DEBIT' : 'CREDIT').txt(entry.amount.toFixed(2));
    }
  }
  return root.end({ prettyPrint: true });
}

// Express configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(requestLogger);

// File upload middleware for Tally import
const upload = multer({ dest: path.join(__dirname, '../uploads') });

// Route: Login form
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Route: Handle login form submission
app.post('/login', async (req, res) => {
  const { password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';
  const success = password === LOGIN_PASSWORD;
  // Record login history regardless of outcome
  await recordLoginHistory({ ip, userAgent, success });
  await appendLoginIp({ ip, userAgent, success });
  if (!success) {
    return res.render('login', { error: 'Invalid password' });
  }
  // Create session, associate with default branch if none exists
  const branches = await prisma.branch.findMany();
  const branchId = branches.length > 0 ? branches[0].id : null;
  const { session, refreshToken } = await createSession({ ip, userAgent, branchId });
  const accessToken = generateAccessToken(session);
  const refreshJwt = generateRefreshToken(session, refreshToken);
  // Set cookies
  res.cookie('accessToken', accessToken, { httpOnly: true });
  res.cookie('refreshToken', refreshJwt, { httpOnly: true });
  res.redirect('/');
});

// Route: Refresh token endpoint
app.post('/auth/refresh', async (req, res) => {
  const token = req.cookies['refreshToken'];
  if (!token) return res.status(401).send('No refresh token');
  try {
    const payload = jwt.verify(token, REFRESH_SECRET);
    const session = await prisma.userSession.findFirst({ where: { sessionId: payload.sessionId } });
    if (!session) throw new Error('Session not found');
    if (session.refreshToken !== payload.token) throw new Error('Refresh token mismatch');
    if (session.expiresAt < new Date()) throw new Error('Refresh token expired');
    // Rotate refresh token
    const newRefresh = uuidv4();
    const updated = await prisma.userSession.update({ where: { id: session.id }, data: { refreshToken: newRefresh } });
    const newAccessToken = generateAccessToken(updated);
    const newRefreshJwt = generateRefreshToken(updated, newRefresh);
    res.cookie('accessToken', newAccessToken, { httpOnly: true });
    res.cookie('refreshToken', newRefreshJwt, { httpOnly: true });
    res.status(200).send('Refreshed');
  } catch (err) {
    console.error('Refresh failed', err);
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    return res.status(401).send('Invalid refresh');
  }
});

// Logout endpoint
app.get('/logout', async (req, res) => {
  const refresh = req.cookies['refreshToken'];
  if (refresh) {
    try {
      const payload = jwt.verify(refresh, REFRESH_SECRET);
      await prisma.userSession.deleteMany({ where: { sessionId: payload.sessionId } });
    } catch (err) {}
  }
  res.clearCookie('accessToken');
  res.clearCookie('refreshToken');
  res.redirect('/login');
});

// Protect all routes below
app.use(authMiddleware);

// Dashboard
app.get('/', async (req, res) => {
  const branchId = req.branchId;
  // Aggregate counts for dashboard (return 0 when none)
  const [prodCount, labourCount, invCount, challanCount] = await Promise.all([
    prisma.productionEntry.count({ where: { branchId } }),
    prisma.labourPayment.count({ where: { branchId } }),
    prisma.inventoryRoll.count({ where: { branchId } }),
    prisma.factoryChallan.count({ where: { branchId } })
  ]);
  const branches = await prisma.branch.findMany();
  res.render('dashboard', {
    branchId,
    branches,
    prodCount,
    labourCount,
    invCount,
    challanCount
  });
});

// Branch switcher
app.get('/branch/select/:id', async (req, res) => {
  const branchId = parseInt(req.params.id, 10);
  const session = req.sessionInfo;
  await prisma.userSession.update({ where: { id: session.id }, data: { branchId } });
  res.redirect('/');
});

/* Production Routes */
app.get('/production', async (req, res) => {
  const branchId = req.branchId;
  const productions = await prisma.productionEntry.findMany({
    where: { branchId },
    include: { department: true, machine: true, workers: { include: { worker: true } } }
  });
  const branches = await prisma.branch.findMany();
  res.render('production/list', { productions, branches, branchId });
});

app.get('/production/new', async (req, res) => {
  const branchId = req.branchId;
  const departments = await prisma.department.findMany({ where: { branchId } });
  const machines = await prisma.machine.findMany({ where: { branchId } });
  const workers = await prisma.worker.findMany({ where: { branchId } });
  res.render('production/new', { departments, machines, workers, error: null });
});

app.post('/production/new', async (req, res) => {
  const branchId = req.branchId;
  const { date, shift, departmentId, machineId, outputQty, outputUnit, rejectionQty, rejectionReason, workerIds } = req.body;
  try {
    // Create production entry
    const entry = await prisma.productionEntry.create({
      data: {
        date: new Date(date),
        shift,
        branchId,
        departmentId: departmentId ? parseInt(departmentId, 10) : null,
        machineId: machineId ? parseInt(machineId, 10) : null,
        outputQty: parseFloat(outputQty),
        outputUnit,
        rejectionQty: rejectionQty ? parseFloat(rejectionQty) : null,
        rejectionReason: rejectionReason || null
      }
    });
    // Associate workers
    if (workerIds) {
      const ids = Array.isArray(workerIds) ? workerIds : [workerIds];
      for (const wid of ids) {
        await prisma.productionWorker.create({ data: { productionId: entry.id, workerId: parseInt(wid, 10) } });
      }
    }
    await logAudit({
      branchId,
      sessionId: req.sessionInfo.sessionId,
      ip: req.sessionInfo.ip,
      action: 'CREATE',
      entity: 'ProductionEntry',
      entityId: entry.id,
      before: null,
      after: entry
    });
    res.redirect('/production');
  } catch (err) {
    console.error(err);
    const departments = await prisma.department.findMany({ where: { branchId } });
    const machines = await prisma.machine.findMany({ where: { branchId } });
    const workers = await prisma.worker.findMany({ where: { branchId } });
    res.render('production/new', { departments, machines, workers, error: 'Failed to create production' });
  }
});

// Cancel production entry (soft delete)
app.post('/production/:id/cancel', async (req, res) => {
  const branchId = req.branchId;
  const id = parseInt(req.params.id, 10);
  const before = await prisma.productionEntry.findUnique({ where: { id } });
  if (!before) return res.redirect('/production');
  await prisma.productionEntry.delete({ where: { id } });
  await logAudit({
    branchId,
    sessionId: req.sessionInfo.sessionId,
    ip: req.sessionInfo.ip,
    action: 'CANCEL',
    entity: 'ProductionEntry',
    entityId: id,
    before,
    after: null
  });
  res.redirect('/production');
});

/* Labour Payment Routes */
app.get('/labour', async (req, res) => {
  const branchId = req.branchId;
  const payments = await prisma.labourPayment.findMany({ where: { branchId }, include: { worker: true } });
  const branches = await prisma.branch.findMany();
  res.render('labour/list', { payments, branches, branchId });
});

app.get('/labour/new', async (req, res) => {
  const branchId = req.branchId;
  const workers = await prisma.worker.findMany({ where: { branchId } });
  res.render('labour/new', { workers, error: null });
});

app.post('/labour/new', async (req, res) => {
  const branchId = req.branchId;
  const { workerId, date, amount, mode, remarks } = req.body;
  try {
    const payment = await prisma.labourPayment.create({
      data: {
        workerId: workerId ? parseInt(workerId, 10) : null,
        branchId,
        date: new Date(date),
        amount: parseFloat(amount),
        mode,
        remarks: remarks || null
      }
    });
    // Add ledger entry
    await prisma.ledgerEntry.create({
      data: {
        branchId,
        type: 'Labour Payment',
        date: new Date(date),
        description: remarks || `Payment to worker ${workerId}`,
        debit: payment.amount,
        credit: 0,
        balance: 0
      }
    });
    await logAudit({
      branchId,
      sessionId: req.sessionInfo.sessionId,
      ip: req.sessionInfo.ip,
      action: 'CREATE',
      entity: 'LabourPayment',
      entityId: payment.id,
      before: null,
      after: payment
    });
    res.redirect('/labour');
  } catch (err) {
    console.error(err);
    const workers = await prisma.worker.findMany({ where: { branchId } });
    res.render('labour/new', { workers, error: 'Failed to create payment' });
  }
});

app.post('/labour/:id/cancel', async (req, res) => {
  const branchId = req.branchId;
  const id = parseInt(req.params.id, 10);
  const before = await prisma.labourPayment.findUnique({ where: { id } });
  if (!before) return res.redirect('/labour');
  await prisma.labourPayment.delete({ where: { id } });
  await logAudit({
    branchId,
    sessionId: req.sessionInfo.sessionId,
    ip: req.sessionInfo.ip,
    action: 'CANCEL',
    entity: 'LabourPayment',
    entityId: id,
    before,
    after: null
  });
  res.redirect('/labour');
});

/* Inventory Routes */
app.get('/inventory', async (req, res) => {
  const branchId = req.branchId;
  const rolls = await prisma.inventoryRoll.findMany({ where: { branchId } });
  const branches = await prisma.branch.findMany();
  res.render('inventory/list', { rolls, branches, branchId });
});

app.get('/inventory/new', async (req, res) => {
  res.render('inventory/new', { error: null });
});

app.post('/inventory/new', async (req, res) => {
  const branchId = req.branchId;
  const { rollId, supplier, gsm, width, color, quantity } = req.body;
  try {
    const roll = await prisma.inventoryRoll.create({
      data: {
        branchId,
        rollId,
        supplier,
        gsm: parseFloat(gsm),
        width: parseFloat(width),
        color,
        remaining: parseFloat(quantity)
      }
    });
    await prisma.stockMovement.create({
      data: {
        rollIdRef: roll.id,
        branchId,
        type: 'IN',
        quantity: parseFloat(quantity),
        date: new Date(),
        reason: 'Initial Inward'
      }
    });
    await logAudit({
      branchId,
      sessionId: req.sessionInfo.sessionId,
      ip: req.sessionInfo.ip,
      action: 'CREATE',
      entity: 'InventoryRoll',
      entityId: roll.id,
      before: null,
      after: roll
    });
    res.redirect('/inventory');
  } catch (err) {
    console.error(err);
    res.render('inventory/new', { error: 'Failed to add roll' });
  }
});

/* Tally Integration Routes */
app.get('/tally', async (req, res) => {
  const branchId = req.branchId;
  res.render('tally/index');
});

// Export invoices (challans) to Tally
app.get('/tally/export/invoices', async (req, res) => {
  const branchId = req.branchId;
  const challans = await prisma.factoryChallan.findMany({ where: { branchId }, include: { items: true } });
  const vouchers = challans.map((ch) => {
    const entries = [];
    // Each challan becomes a sales voucher: credit sales account, debit party account
    // For simplicity, we hardcode ledger names
    const total = ch.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    entries.push({ ledgerName: ch.partyName || 'Customer', isDebit: true, amount: total });
    entries.push({ ledgerName: 'Sales', isDebit: false, amount: total });
    return {
      date: ch.date.toISOString().substring(0, 10).replace(/-/g, ''),
      reference: `CH${ch.number}`,
      narration: `Sales challan ${ch.number}`,
      entries
    };
  });
  const xml = buildTallyVoucherXML({ vouchers, voucherType: 'Sales' });
  const fileName = `sales_${Date.now()}.xml`;
  const filePath = path.join(TALLY_OUTBOX_DIR, fileName);
  fs.writeFileSync(filePath, xml);
  await prisma.tallyExportJob.create({ data: { branchId, type: 'Sales', filePath, status: 'GENERATED' } });
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
  res.send(xml);
});

// Export labour/vendor payments to Tally
app.get('/tally/export/payments', async (req, res) => {
  const branchId = req.branchId;
  // Collect labour payments and vendor payments
  const labour = await prisma.labourPayment.findMany({ where: { branchId }, include: { worker: true } });
  const vendor = await prisma.vendorPayment.findMany({ where: { branchId }, include: { vendor: true } });
  const vouchers = [];
  for (const p of labour) {
    vouchers.push({
      date: p.date.toISOString().substring(0, 10).replace(/-/g, ''),
      reference: `LP${p.id}`,
      narration: p.remarks || 'Labour payment',
      entries: [
        { ledgerName: 'Wages', isDebit: true, amount: p.amount },
        { ledgerName: 'Cash', isDebit: false, amount: p.amount }
      ]
    });
  }
  for (const p of vendor) {
    vouchers.push({
      date: p.date.toISOString().substring(0, 10).replace(/-/g, ''),
      reference: `VP${p.id}`,
      narration: p.remarks || 'Vendor payment',
      entries: [
        { ledgerName: 'Purchases', isDebit: true, amount: p.amount },
        { ledgerName: 'Cash', isDebit: false, amount: p.amount }
      ]
    });
  }
  const xml = buildTallyVoucherXML({ vouchers, voucherType: 'Payment' });
  const fileName = `payments_${Date.now()}.xml`;
  const filePath = path.join(TALLY_OUTBOX_DIR, fileName);
  fs.writeFileSync(filePath, xml);
  await prisma.tallyExportJob.create({ data: { branchId, type: 'Payment', filePath, status: 'GENERATED' } });
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
  res.send(xml);
});

// Tally mapping screen (basic)
app.get('/tally/mapping', async (req, res) => {
  const branchId = req.branchId;
  const mappings = await prisma.tallyMapping.findMany({ where: { branchId } });
  res.render('tally/mapping', { mappings });
});

// Save mapping
app.post('/tally/mapping', async (req, res) => {
  const branchId = req.branchId;
  const { mappingType, erpId, tallyName } = req.body;
  await prisma.tallyMapping.create({ data: { branchId, mappingType, erpId: erpId ? parseInt(erpId, 10) : null, tallyName } });
  res.redirect('/tally/mapping');
});

// Tally import: upload and preview party masters
app.get('/tally/import/parties', (req, res) => {
  res.render('tally/import');
});

app.post('/tally/import/parties', upload.single('file'), async (req, res) => {
  const branchId = req.branchId;
  const file = req.file;
  if (!file) return res.render('tally/import', { error: 'No file uploaded' });
  const xmlContent = fs.readFileSync(file.path, 'utf8');
  // Very naive parsing: look for LEDGER NAME attribute
  const ledgerRegex = /<LEDGER[^>]*NAME="([^"]+)"/g;
  const names = [];
  let match;
  while ((match = ledgerRegex.exec(xmlContent)) !== null) {
    names.push(match[1]);
  }
  // Remove duplicates
  const unique = [...new Set(names)];
  res.render('tally/preview', { parties: unique, branchId });
});

app.post('/tally/import/parties/apply', async (req, res) => {
  const branchId = req.branchId;
  const { names } = req.body;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    await prisma.vendor.upsert({
      where: { name, branchId },
      update: {},
      create: { name, branchId }
    });
  }
  await prisma.tallyImportJob.create({ data: { branchId, type: 'Parties', filePath: '', status: 'IMPORTED' } });
  res.redirect('/tally/mapping');
});

// Reset branch data (admin only) – clears transactional tables for selected branch
app.post('/branch/:id/reset', async (req, res) => {
  const branchId = parseInt(req.params.id, 10);
  // Delete transactional data but keep masters
  await prisma.$transaction([
    prisma.productionEntry.deleteMany({ where: { branchId } }),
    prisma.labourPayment.deleteMany({ where: { branchId } }),
    prisma.inventoryRoll.deleteMany({ where: { branchId } }),
    prisma.factoryChallan.deleteMany({ where: { branchId } }),
    prisma.vendorPayment.deleteMany({ where: { branchId } }),
    prisma.ledgerEntry.deleteMany({ where: { branchId } }),
    prisma.auditLog.deleteMany({ where: { branchId } }),
    prisma.tallyExportJob.deleteMany({ where: { branchId } }),
    prisma.tallyImportJob.deleteMany({ where: { branchId } })
  ]);
  await logAudit({
    branchId,
    sessionId: req.sessionInfo.sessionId,
    ip: req.sessionInfo.ip,
    action: 'RESET',
    entity: 'Branch',
    entityId: branchId,
    before: null,
    after: null
  });
  res.redirect('/');
});

// Start server
async function start() {
  ensureDirectories();
  await initDatabase();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Factory ERP server running on port ${port}`);
  });
}

start().catch((err) => {
  console.error(err);
});