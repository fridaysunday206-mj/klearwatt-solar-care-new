# KlearWatt Solar Care — website rebuild notes

- Repositioned the website as a specialist solar-panel cleaning business only. Public marketing no longer advertises solar installation, inverter repairs or general maintenance.
- Built separate residential and commercial customer paths, with a responsive, mobile-first design and clear service-area/contact details.
- Added the confirmed business email: fridaysunday206@gmail.com.
- Added a public quotation-request API and database table. The form accepts residential and commercial enquiries, site type, panel count, installation type, access information, location, preferred cleaning schedule and notes.
- Added administrator-only quotation management: review requests, set a proposed quote and update request status. Quotation requests are separate from bookings and payments.
- Large commercial sites and solar farms are directed to custom quotations rather than fixed public prices.
- Kept the existing customer accounts, booking/payment flows, Paystack verification and admin price controls. Existing databases receive the new quotation table on startup through `CREATE TABLE IF NOT EXISTS`.
- Removed externally hosted stock-photo dependencies from the two customer-type cards; the artwork is CSS-based so those cards do not disappear if a third-party image host is unavailable.
- Kept the existing hero before/after artwork clearly labelled as illustrative, not an actual KlearWatt customer job.
- Expanded the automated test suite to 64 tests, including public quotation submission, invalid request rejection, admin-only visibility, and admin quote/status updates.
- Tests use a local mock Paystack. No real Paystack transaction or live hosting deployment has been performed.
