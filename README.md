# Factory ERP

This repository contains a minimal yet functional Factory ERP web application tailored for a textile/quilting factory.  It demonstrates how to build a password‑only authentication flow, branch separation, production management, labour payments, inventory handling and basic Tally integration using Node.js, Express, Prisma and EJS.

> **Important:** The implementation provided here is for demonstration purposes and is **not production ready**.  Before deploying to a live environment you **must** add proper user management, secure password hashing, thorough validation and comprehensive permission checks.

## Features

* **Authentication** – Single password login (`admin123`) with JWT access and refresh tokens stored in HTTP‑only cookies.  Every login records the IP address and user agent in a database table and appends the same information to a server‑side file called `loginip`.
* **Branch separation** – All transactional data is linked to a branch.  Users can switch between branches via a drop‑down in the top bar.  Each branch maintains its own productions, labour payments, inventory, challans and ledgers.
* **Dashboard** – Displays key performance indicators (KPIs) for the selected branch.  Fresh installations show zero values instead of dummy data.
* **Production management** – Record daily production output for configurable departments and optional machines with multiple workers.  Cancelled entries are removed from the database and logged to the audit table.
* **Labour payments** – Capture payments to workers (cash/UPI).  Payments automatically create ledger entries.  Cancellations are logged.
* **Inventory** – Manage fabric rolls (inwards only) with GSM, width, colour and quantity.  A stock movement is created for each inward transaction.
* **Tally integration** – Export sales vouchers (challans) and payment vouchers (labour/vendor) as XML in a Tally‑compatible format.  Each export writes a file into `integrations/tally/outbox` and creates a `TallyExportJob` record.  Import party masters from a Tally XML file by uploading it; the system previews the ledgers detected and allows you to import selected names into the `Vendor` table.  Simple mapping tables let you map ERP entities to Tally names.
* **Audit logging** – Every create, cancel or reset operation writes an audit log entry with before/after JSON and the acting session/IP.
* **Reset branch data** – Admins can wipe all transactional data for a branch (production, labour, inventory, challans, vendor payments, ledger entries, audit logs and Tally jobs) without removing masters such as departments or machines.

## Prerequisites

* [Node.js](https://nodejs.org/) ≥ 16
* [npm](https://npmjs.com/)  (or [yarn](https://yarnpkg.com/))

## Installation

1. Clone this repository and change into the project directory:

   ```bash
   git clone <repo-url>
   cd factory-erp
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Generate the Prisma client and create the SQLite database:

   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```

   The first migration will create a file `prisma/dev.db` containing an empty database.

4. Start the development server:

   ```bash
   npm run dev
   ```

   The app will run on http://localhost:3000.  On first launch a default branch called **Main Branch** and standard quilting departments are seeded automatically.

## Usage

1. Navigate to [http://localhost:3000/login](http://localhost:3000/login) and log in with password `admin123`.  The login page only asks for a password; no username is required.  Every login attempt (success or failure) is recorded in both the `LoginHistory` table and a file named `loginip` inside the `data` directory.

2. Once logged in you are taken to the dashboard.  Use the sidebar links to access Production, Labour or Inventory modules.  Each list page offers a **New** button to create entries, and tables show existing records.  Cancellation buttons remove records and write to the audit log.

3. Use the **Tally** section to export vouchers or import party masters:

   * **Export Sales Vouchers** – Serialises all challans for the current branch into a Tally‐compatible XML file, writes it into `integrations/tally/outbox` and downloads it to your browser.
   * **Export Payment Vouchers** – Serialises all labour and vendor payments in a similar manner.
   * **Tally Mapping** – Create mappings between your ERP IDs and Tally ledger/company names.
   * **Import Parties** – Upload a Tally XML containing ledgers (typically exported from Tally).  The system scans for `<LEDGER NAME="…">` tags, shows a preview and lets you import selected names into the `Vendor` table.

4. To reset transactional data for a branch (e.g. to return the dashboard to zero values), send a POST request to `/branch/<id>/reset` (replace `<id>` with the branch ID).  This operation deletes all production, labour, inventory, challan, vendor payment and ledger entries for the branch and logs the action.

## Environment Variables

The server uses a few secrets defined in `src/server.js` for JWT signing.  For a real deployment you should override these values using environment variables.  Set the following environment variables before starting the server:

* `JWT_SECRET` – secret used to sign access tokens.
* `REFRESH_SECRET` – secret used to sign refresh tokens.

You can supply them on the command line:

```bash
JWT_SECRET=mysecret REFRESH_SECRET=myrefresh npm start
```

## File Structure

```
factory-erp/
├── prisma/
│   └── schema.prisma          Prisma schema defining all models.
├── public/
│   └── css/styles.css         Basic styling for pages.
├── src/
│   └── server.js              Express application implementing API routes and views.
├── views/
│   ├── dashboard.ejs          Dashboard page.
│   ├── login.ejs              Login form.
│   ├── production/            Production pages.
│   │   ├── list.ejs
│   │   └── new.ejs
│   ├── labour/                Labour payment pages.
│   │   ├── list.ejs
│   │   └── new.ejs
│   ├── inventory/             Inventory pages.
│   │   ├── list.ejs
│   │   └── new.ejs
│   └── tally/                 Tally integration pages.
│       ├── index.ejs
│       ├── mapping.ejs
│       ├── import.ejs
│       └── preview.ejs
├── integrations/
│   └── tally/
│       ├── inbox/             Place incoming Tally files here for automatic processing.
│       └── outbox/            Tally exports are written here.
├── data/
│   └── loginip                File containing IP history for all login attempts.
└── README.md                  This file.
```

## Limitations and Future Work

This project intentionally focuses on clarity over completeness.  Although every UI button is wired to a real database operation and audit log, many advanced features described in the specification (e.g. complex multi‑item challans, vendor payments, orders, storage movements, Tally API bridging and dark/light mode toggling) are not fully implemented here.  You are encouraged to extend the existing patterns to cover those requirements:

* Add the missing modules (challans, orders, vendor payments, storage) with corresponding pages and API routes.
* Implement per‑branch numbering for challans and invoices based on the financial year.
* Integrate a client‑side framework (React or Vue) and TanStack Table for richer interactions and better UX.
* Replace the hardcoded password with a secure hashed password and user management, and add role‑based access control.
* Improve the Tally integration by adding more voucher types and robust XML parsing.
* Convert the simple ledger implementation into a proper double‑entry accounting system.

Pull requests are welcome!