import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { renderPayslipPdf, samplePayslip } from "../src/lib/finance/payslip-pdf";
import { previousMonth } from "../src/lib/finance/payslip";
import { todayLagos } from "../src/lib/finance/dates";

/** Payslips must be the latest: last month's is always accepted. */
const LAST_MONTH = previousMonth(todayLagos().slice(0, 7));
const LAST_MONTH_NAME = new Date(`${LAST_MONTH}-15T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

async function signIn(page: Page, name: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  // Applicants land on their dashboard; staff with a work role in their work area.
  await page.waitForURL((u) => !["/login", "/home"].includes(u.pathname));
  if (page.url().endsWith("/mfa")) {
    // HR, Accounts, approvers and administrators must complete two-step verification. Test accounts
    // show the current authenticator code on the page (development only).
    await page.getByLabel(/code/i).first().fill(await page.getByTestId("dev-mfa-code").innerText());
    await page.getByRole("button", { name: /Verify/ }).click();
    await page.waitForURL((u) => !["/mfa", "/home"].includes(u.pathname));
  }
}

// Actions that change something ask for confirmation in a dialog; accept it, as the person would.
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.locator("dialog[data-confirm-dialog][open]"), async (d) => {
    await d.getByRole("button", { name: "Confirm" }).click();
  }, { noWaitAfter: true });
});

const GRAPH = "http://127.0.0.1:3199";
type Mail = { to: string; subject: string; html: string; attachments: { contentId: string }[] };
/** A click before the page finishes loading does nothing, so keep trying until the menu opens. */
async function openRowMenu(page: Page, name: string) {
  await expect(async () => {
    if (!(await page.getByRole("menu").isVisible())) await page.getByRole("button", { name }).click();
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
}

const mails = async (): Promise<Mail[]> => (await fetch(`${GRAPH}/_captured`)).json();

const PDF = { name: "payslip.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% e2e payslip\n%%EOF") };

test.describe.serial("application lifecycle through the UI", () => {
  let appPath = "";
  let accountNumber = "";

  test("administrator sets the Head of Computer Science under Organisation", async ({ page }) => {
    await signIn(page, "Emeka Nwosu");
    await page.goto("/admin/organisation");
    await openRowMenu(page, "Actions for Computer Science");
    await page.getByRole("menuitem", { name: "Manage" }).click();
    await page.getByLabel("Approved by").selectOption({ label: "HOD" });
    await page.getByLabel("Approver").selectOption({ label: "Funmilayo Adebayo" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.goto("/admin/organisation");
    await expect(page.getByRole("row", { name: /Computer Science.*Funmilayo Adebayo/ })).toBeVisible();
  });

  test("applicant drafts, uploads a payslip and submits", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await signIn(page, "Tunde Bello");
    await page.goto("/applications/new");
    // Tunde already guarantees a loan, so less of his limit is left: ₦150,000 fits.
    await page.getByLabel("Amount requested (₦)").fill("150000");
    await page.getByLabel("Tenor", { exact: true }).selectOption("12");
    await page.getByLabel("Purpose").fill("School fees for the new academic session");
    await page.getByLabel("Telephone number").fill("+234 803 111 2222");
    await page.getByLabel("Residential address").fill("12 Admiralty Way, Lekki, Lagos");
    await page.getByLabel("Guarantor 1").selectOption({ label: "Emeka Nwosu" });
    await page.getByLabel("Guarantor 2").selectOption({ label: "Chidi Obi" });
    await page.getByRole("button", { name: "Save draft and continue" }).click();
    await page.waitForURL(/\/applications\/[0-9a-f-]{36}$/);
    appPath = new URL(page.url()).pathname;

    // The payslip it was assessed on is filed with the application.
    await expect(page.getByText(/Payslip \d{4}-\d{2}/).first()).toBeVisible();

    await page.getByRole("checkbox", { name: /I have read and accept the loan terms/ }).check();
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(page.getByText("Awaiting guarantors").first()).toBeVisible();
  });

  for (const name of ["Emeka Nwosu", "Chidi Obi"]) {
    test(`guarantor ${name} accepts with an electronic signature`, async ({ page }) => {
      page.on("dialog", (d) => d.accept());
      await signIn(page, name);
      await page.goto("/guarantor");
      await page.getByRole("link", { name: /Review/ }).first().click();
      await expect(page.getByText("Amount you would guarantee")).toBeVisible();
      // The guarantor's own payslip shows they could cover their share; only then can they accept.
      await expect(page.getByText(/^Uploaded [0-9]/)).toBeVisible();
      await expect(page.getByText(/You could cover/)).toBeVisible();
      for (const box of await page.locator('input[name^="c"][type="checkbox"]').all()) await box.check();
      await page.getByLabel("Relationship with the applicant").selectOption("Colleague");
      await page.getByLabel("Your telephone number(s)").fill("08031234567, 08097654321");
      await page.getByLabel(/Type your full name to sign/).fill(name);
      await page.getByRole("button", { name: "Accept and sign electronically" }).click();
      await expect(page).toHaveURL(/\/guarantor$/);
    });
  }

  test("HR administrator verifies and forwards to the Bursary", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await signIn(page, "Kunle Adeyemi");
    await page.goto(`/hr${appPath}`);
    for (const n of ["employmentVerified", "salaryVerified", "staffStatusVerified", "departmentVerified"]) await page.locator(`input[name="${n}"]`).check();
    for (const sel of await page.locator('select[name^="g_"]').all()) await sel.selectOption("capable");
    await page.getByLabel(/Due-diligence notes/).fill("Employment and salary confirmed against payroll; guarantors capable.");
    await page.locator('input[name="outcome"][value="verified"]').check();
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect(page.getByText(/Verified by Human Resources and forwarded/).first()).toBeVisible({ timeout: 30_000 });
  });

  test("Bursary Officer sees loan history and the deduction check, confirms funds and sends it to the Line Manager", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await signIn(page, "Chioma Nnaji");
    await page.goto("/bursary/review");
    await page.getByRole("link", { name: /LMS-\d{6}-\d{3}/ }).first().click();
    await expect(page.getByRole("heading", { name: "Bursary information" })).toBeVisible();
    await expect(page.getByText(/Deduction check: all deductions within 33.3% of net pay/)).toBeVisible();
    await expect(page.getByText("Passed")).toBeVisible();
    const form = await page.request.get(`/api/applications/${appPath.split("/").pop()}/form`);
    expect(form.headers()["content-type"]).toBe("application/pdf");
    const gform = await page.request.get(`/api/applications/${appPath.split("/").pop()}/form?type=guarantor`);
    expect(gform.headers()["content-type"]).toBe("application/pdf");
    await page.getByLabel(/I confirm that funds are available/).check();
    await page.getByLabel("Comments").fill("Funds available in the staff loan budget.");
    await page.locator('input[name="decision"][value="cleared"]').check();
    await page.getByRole("button", { name: "Record decision" }).click();
    await expect(page.getByText("Awaiting approval").first()).toBeVisible();
  });

  for (const name of ["Funmilayo Adebayo", "Halima Musa"]) {
    test(`${name === "Halima Musa" ? "HR Director" : "Line Manager"} ${name} approves and sends it on`, async ({ page }) => {
      page.on("dialog", (d) => d.accept());
      await signIn(page, name);
      await page.goto("/approvals");
      await page.getByRole("link", { name: /LMS-\d{6}-\d{3}/ }).first().click();
      await expect(page.getByRole("heading", { name: /Your decision/ })).toBeVisible();
      await page.locator('input[name="decision"][value="approved"]').check();
      await page.getByLabel("Basis for decision").fill("Supported; within policy.");
      await page.getByRole("button", { name: "Record decision" }).click();
      await expect(page.getByText(name === "Halima Musa" ? "Now at: Bursar's final approval" : "Now at: HR Director approval")).toBeVisible();
    });
  }

  test("the Bursar gives final approval and a loan account is opened", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await signIn(page, "Bisi Lawal");
    await page.goto(`/approvals${appPath.replace("/applications", "")}`);
    await page.locator('input[name="decision"][value="approved"]').check();
    await page.getByLabel("Basis for decision").fill("Within policy; HR verification satisfactory.");
    await page.getByRole("button", { name: "Record decision" }).click();
    const opened = page.getByText(/Loan account LMS-\d{6}-\d{3} opened/);
    await expect(opened).toBeVisible();
    accountNumber = (await opened.innerText()).match(/LMS-\d{6}-\d{3}/)![0];
  });

  test("applicant sees the approved loan awaiting payment", async ({ page }) => {
    await signIn(page, "Tunde Bello");
    await page.goto(appPath);
    await page.getByRole("link", { name: /View loan LMS-/ }).click();
    await expect(page.getByText("Approved and awaiting payment")).toBeVisible();
    // The borrower adds the salary account the Bursary will pay into.
    await page.goto("/profile");
    await page.getByLabel("Bank", { exact: true }).fill("Test Bank");
    await page.getByLabel("Account name").fill("Tunde Bello");
    await page.getByLabel("Account number", { exact: true }).fill("0123456789");
    await page.locator("form").filter({ has: page.getByLabel("Bank", { exact: true }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").first()).toBeVisible();
  });

  test("Accounts Payable Officer pays it out and the loan becomes active", async ({ page }) => {
    await signIn(page, "Chidi Obi");
    await page.goto("/accounts/disbursements");
    const item = page.locator("li", { hasText: accountNumber }).first();
    await item.getByText("Enter payment details").click();
    await item.getByLabel("Bank transaction reference").fill("FT-E2E-0001");
    await item.getByRole("button", { name: "Record payment" }).click();
    await expect(page.locator("li", { hasText: accountNumber })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "FT-E2E-0001" })).toBeVisible();
  });

  test("Payroll Officer records a salary deduction", async ({ page }) => {
    await signIn(page, "Amaka Eze");
    await page.goto("/accounts/loans");
    await page.getByRole("link", { name: accountNumber }).first().click();
    await page.locator("#rref").fill("PAYROLL-E2E-001");
    await page.getByRole("button", { name: "Record repayment" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Repayment LMS-\d{6}-\d{3} posted/ })).toBeVisible();
  });

  test("borrower reports this month's repayment; the Payroll Officer confirms it, deductions become automatic and the monthly export lists it", async ({ page }) => {
    await signIn(page, "Tunde Bello");
    await page.goto("/loans");
    await page.getByRole("link", { name: accountNumber }).first().click();
    await page.getByRole("link", { name: "Report repayment" }).click();
    await page.getByRole("button", { name: "Submit for confirmation" }).click();
    await expect(page.getByRole("status").first()).toBeVisible();

    await signIn(page, "Amaka Eze");
    await page.goto("/accounts/repayments");
    const claim = page.locator("li", { hasText: "Tunde Bello" }).first();
    await claim.locator('input[name="bankReference"]').fill("PAYROLL-E2E-CLAIM");
    await claim.getByRole("button", { name: "Confirm repayment" }).click();
    await expect(page.locator("li", { hasText: "Tunde Bello" }).filter({ has: page.getByRole("button", { name: "Confirm repayment" }) })).toHaveCount(0);
    const csv = await page.request.get(`/api/reports/export?report=repayment_claims&format=csv&month=${new Date().toISOString().slice(0, 7)}`);
    expect(csv.status()).toBe(200);
    const text = await csv.text();
    expect(text).toContain(accountNumber);
    expect(text).toContain("Confirmed");

    // From now on deductions are recorded automatically; the borrower can also repay the whole balance early.
    await signIn(page, "Tunde Bello");
    await page.goto("/loans");
    await page.getByRole("link", { name: accountNumber }).first().click();
    await expect(page.getByText("Repayments are automatic")).toBeVisible();
    await expect(page.getByRole("link", { name: "Report repayment" })).toHaveCount(0);
    await page.getByRole("link", { name: "Repay early" }).click();
    await expect(page.getByRole("heading", { name: "Amount to pay today" })).toBeVisible();
    await expect(page.getByText("Loan balance to repay")).toBeVisible();
  });

  test("eligibility calculator: payslip in, a plain answer out", async ({ page }) => {
    await signIn(page, "Seun Bakare"); // no loan yet
    await page.goto("/eligibility");
    // A payslip that is not theirs is refused, with the reason.
    await page.getByLabel("Your latest payslip (PDF)").setInputFiles({ name: "payslip.pdf", mimeType: "application/pdf", buffer: Buffer.from(await renderPayslipPdf(samplePayslip({ name: "Someone Else", code: "DEV-9999", grade: "Lecturer II Step 4", period: LAST_MONTH, basic: "350000", medical: "24500", tax: "52500", pension: "28000" }))) });
    await page.getByRole("button", { name: "Read payslip" }).click();
    await expect(page.getByText(/does not match your profile/)).toBeVisible();
    // An older payslip of their own is refused: it could leave out deductions that started since.
    await page.getByLabel("Your latest payslip (PDF)").setInputFiles({ name: "payslip.pdf", mimeType: "application/pdf", buffer: Buffer.from(await renderPayslipPdf(samplePayslip({ name: "Seun Bakare", code: "DEV-1005", grade: "Lecturer II Step 4", period: previousMonth(LAST_MONTH), basic: "350000", medical: "24500", tax: "52500", pension: "28000" }))) });
    await page.getByRole("button", { name: "Read payslip" }).click();
    await expect(page.getByText(/Please upload your latest payslip/)).toBeVisible();
    // Their own payslip is read and the limit worked out from it: 350,000 + 24,500 − 52,500 − 28,000 = 294,000 net.
    await page.getByLabel("Your latest payslip (PDF)").setInputFiles({ name: "payslip.pdf", mimeType: "application/pdf", buffer: Buffer.from(await renderPayslipPdf(samplePayslip({ name: "Seun Bakare", code: "DEV-1005", grade: "Lecturer II Step 4", period: LAST_MONTH, basic: "350000", medical: "24500", tax: "52500", pension: "28000", deductions: [{ label: "Cooperative Contribution", amount: "10000" }, { label: "Cafeteria Meal Deduction", amount: "3000" }] }))) });
    await page.getByRole("button", { name: "Read payslip" }).click();
    await expect(page.getByText(`${LAST_MONTH_NAME} payslip`, { exact: true })).toBeVisible();
    await expect(page.getByText("₦294,000.00").first()).toBeVisible();
    await expect(page.getByText("₦97,902.00").first()).toBeVisible(); // 33.3% of net pay
    await expect(page.getByText(/₦3,000.00 used; ₦25,000.00 is counted/)).toBeVisible(); // cafeteria
    await expect(page.getByText("₦62,902.00").first()).toBeVisible(); // less cooperative 10,000 and cafeteria 25,000
    await expect(page.getByText(/You may borrow up to/)).toBeVisible();
    await page.locator("#amount").fill("300,000");
    await expect(page.getByText("You may apply for ₦300,000.00")).toBeVisible();
    await expect(page.getByText("Monthly instalment", { exact: true }).first()).toBeVisible();
    // 300,000 over 12 months at 10% a year, reducing balance: =PMT(10%/12, 12, -300000) = 26,374.77 a month, 12 × 26,374.77 = 316,497.24 in all.
    await expect(page.locator("dd", { hasText: /^₦316,497.24$/ }).first()).toBeVisible();
    await expect(page.locator("dd", { hasText: /^₦26,374.77$/ }).first()).toBeVisible();
    await page.locator("#tenor").selectOption("6");
    await expect(page.locator("dd", { hasText: /^Tenor: 6 months$/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How this is calculated" })).toBeVisible();
    await page.locator("#amount").fill("90,000,000");
    await expect(page.getByText(/is more than your pay allows/)).toBeVisible();

    // Someone who already has a loan is told why in a pop-up, with no borrowing figure.
    await signIn(page, "Tunde Bello");
    await page.goto("/eligibility");
    await expect(page.getByRole("dialog", { name: "You are not eligible at present" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("You cannot apply at present")).toBeVisible();
  });

  test("borrower downloads a marked receipt and statement; Accounts verifies the receipt", async ({ page }) => {
    await signIn(page, "Tunde Bello");
    await page.goto("/loans");
    await page.getByRole("link", { name: new RegExp(accountNumber) }).first().click();
    await page.waitForURL(/\/loans\/[0-9a-f-]{36}/);
    const loanPath = new URL(page.url()).pathname;
    await page.goto(`${loanPath}?tab=payments`);
    const href = await page.getByRole("link", { name: /receipt LMS-/ }).first().getAttribute("href");
    const receipt = await page.request.get(href!);
    expect(receipt.headers()["content-type"]).toBe("application/pdf");
    const bytes = await receipt.body();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const statement = await page.request.get(`${loanPath.replace("/loans/", "/api/loans/")}/statement`);
    expect(statement.headers()["content-type"]).toBe("application/pdf");

    await signIn(page, "Bisi Lawal");
    await page.goto("/verify");
    await page.getByLabel("PDF document").setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: bytes });
    await page.getByRole("button", { name: "Check file" }).click();
    await expect(page.getByText("Genuine and unaltered")).toBeVisible();
    await page.waitForURL(/\/verify\?sha=/);
    await page.waitForLoadState("networkidle"); // the form re-renders after the redirect; pick the next file only once it has settled
    const altered = Buffer.from(bytes);
    altered[altered.length - 30] ^= 1;
    await page.getByLabel("PDF document").setInputFiles({ name: "altered.pdf", mimeType: "application/pdf", buffer: altered });
    await expect.poll(() => page.getByLabel("PDF document").evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)).toBe(1);
    await page.getByRole("button", { name: "Check file" }).click();
    await expect(page.getByText("Not recognised")).toBeVisible();
  });

  test("every step was emailed through Microsoft 365 with branding and markings", async () => {
    await expect.poll(async () => (await mails()).filter((m) => m.to === "tunde.bello.dev@example.edu.ng").map((m) => m.subject).join(" | "), { timeout: 30_000 })
      .toMatch(/submitted[\s\S]*approved[\s\S]*disbursed[\s\S]*Repayment/);
    const all = await mails();
    for (const who of ["emeka.nwosu.dev@example.edu.ng", "kunle.adeyemi.dev@example.edu.ng", "chioma.nnaji.dev@example.edu.ng", "funmi.adebayo.dev@example.edu.ng", "halima.musa.dev@example.edu.ng", "bisi.lawal.dev@example.edu.ng", "chidi.obi.dev@example.edu.ng"]) {
      expect(all.some((m) => m.to === who), who).toBe(true);
    }
    for (const m of all) {
      expect(m.html).toContain("Loan Management System · Pan-Atlantic University");
      expect(m.attachments.some((a) => a.contentId === "brand-logo")).toBe(true);
      expect(`${m.subject}${m.html}`).not.toContain("\u2014");
    }
  });

  test("reports: portfolio report, a period register and the payroll deduction schedule", async ({ page }) => {
    await signIn(page, "Emeka Nwosu");
    await page.goto("/reports?tab=library");
    await expect(page.getByRole("heading", { name: "Report library" })).toBeVisible();
    await openRowMenu(page, "Actions for Portfolio report download");
    const mgmt = await page.request.get((await page.getByRole("menuitem", { name: "Download PDF" }).getAttribute("href"))!);
    expect(mgmt.headers()["content-type"]).toBe("application/pdf");
    expect((await mgmt.body()).subarray(0, 5).toString()).toBe("%PDF-");
    await page.keyboard.press("Escape");
    await page.getByLabel("Period from").fill("2020-01-01");
    await page.getByRole("button", { name: "Apply" }).click();
    await page.waitForURL(/from=2020-01-01/);
    await openRowMenu(page, "Actions for Disbursements register download");
    const href = await page.getByRole("menuitem", { name: "Download Excel" }).getAttribute("href");
    expect(href).toContain("from=2020-01-01");
    const xlsx = await page.request.get(href!);
    expect(xlsx.headers()["content-disposition"]).toMatch(/disbursements-2020-01-01-to-/);
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");

    await signIn(page, "Chidi Obi"); // Accounts Payable Officer: no report export rights, but can take the payroll schedule
    await page.goto("/accounts/reconciliation");
    const csv = await page.request.get((await page.getByRole("link", { name: "CSV" }).getAttribute("href"))!);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain("Staff no.,Staff name,Department,Loan account,Due date,Instalment due,Arrears brought forward,Total to deduct");
    expect((await page.request.get("/api/reports/export?report=loan_book&format=pdf")).status()).toBe(403);
  });

  test("administrator sends a test email from the outbox page", async ({ page }) => {
    await signIn(page, "Emeka Nwosu");
    await page.goto("/admin/outbox?tab=test");
    await expect(page.getByText("Email delivery is configured")).toBeVisible();
    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(page.getByText(/Test email sent to emeka.nwosu.dev@example.edu.ng/)).toBeVisible();
  });
});

test.describe("inactivity sign-out", () => {
  test("warns a minute before, can be cancelled, then signs out", async ({ page }) => {
    await page.clock.install();
    await signIn(page, "Adaeze Okafor");
    await page.goto("/dashboard");
    await page.waitForTimeout(8000); // The development server reloads a fresh page once; a reload counts as activity.
    const warning = page.getByRole("dialog", { name: "Are you still there?" });
    await expect(warning).toBeHidden();
    const later = async (ms: number) => page.clock.setSystemTime((await page.evaluate(() => Date.now())) + ms);

    await later(555_000);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(/signed out in \d+ seconds/);
    await page.mouse.move(200, 200); // Passing the mouse does not cancel it.
    await page.waitForTimeout(1500);
    await expect(warning).toBeVisible();

    await page.getByRole("button", { name: "Stay signed in" }).click();
    await expect(warning).toBeHidden();

    await later(601_000);
    await page.waitForURL(/\/login\?signedOut=idle/);
    await expect(page.getByRole("status")).toContainText("because you were inactive");
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("security in the browser", () => {
  test("HR, Accounts and administrators cannot use the system until two-step verification is complete", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByRole("button", { name: /^Bisi Lawal/ }).click();
    await page.waitForURL("**/mfa");
    for (const path of ["/accounts", "/dashboard", "/admin"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/mfa$/);
    }
    expect((await page.request.get("/api/reports/export?report=loan_book&format=csv")).status()).toBe(401);
    await page.getByLabel(/code/i).first().fill("000000");
    await page.getByRole("button", { name: /Verify/ }).click();
    await expect(page.getByText(/code is not correct/)).toBeVisible();
    await page.getByLabel(/code/i).first().fill(await page.getByTestId("dev-mfa-code").innerText());
    await page.getByRole("button", { name: /Verify/ }).click();
    // Staff with a work role start in it (the Bursar in the Bursary Overview), with their own loans (Self-service) last in the menu.
    await page.waitForURL(/\/accounts$/);
    await expect(page.locator("aside nav p").last()).toHaveText("Self-service");
    await page.goto("/accounts");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await signIn(page, "Funmilayo Adebayo"); // An HOD has one menu under their title: Overview, then Approvals.
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator("aside nav p").first()).toHaveText("Head of Department");
    await expect(page.locator("aside nav a").nth(0)).toContainText("Overview");
    await expect(page.locator("aside nav a").nth(1)).toContainText("Approvals");
  });

  test("role-restricted pages redirect to access denied", async ({ page }) => {
    await signIn(page, "Adaeze Okafor");
    for (const path of ["/hr", "/accounts", "/admin", "/approvals"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: /permission/ })).toBeVisible();
    }
  });
});

const A11Y: [string, string[]][] = [
  ["Adaeze Okafor", ["/dashboard", "/products", "/eligibility", "/applications", "/applications/new", "/loans", "/profile", "/notifications"]],
  ["Ngozi Eze", ["/guarantor"]],
  ["Kunle Adeyemi", ["/hr", "/hr/applications", "/hr/staff"]],
  ["Chioma Nnaji", ["/bursary/review", "/accounts/repayments", "/accounts/loans"]],
  ["Funmilayo Adebayo", ["/approvals"]],
  ["Yetunde Ajayi", ["/approvals"]],
  ["Halima Musa", ["/approvals", "/reports"]],
  ["Bisi Lawal", ["/accounts", "/approvals", "/accounts/loans", "/accounts/reconciliation", "/verify"]],
  ["Chidi Obi", ["/accounts/disbursements"]],
  ["Amaka Eze", ["/payroll", "/accounts/repayments"]],
  ["Folake Ojo", ["/payroll", "/payroll/early-repayments"]],
  ["Ibrahim Sani", ["/finance", "/dashboard"]],
  ["Emeka Nwosu", ["/admin", "/admin/users", "/admin/users/new?tab=many", "/admin/guarantors", "/admin/guarantors/new?tab=many", "/admin/products", "/admin/branding", "/admin/settings", "/admin/outbox", "/admin/audit", "/reports"]],
];

test.describe("accessibility (axe, WCAG 2.2 AA)", () => {
  test("login and privacy pages", async ({ page }) => {
    for (const path of ["/login", "/privacy"]) {
      await page.goto(path);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${path}: ${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
    }
  });

  for (const [user, paths] of A11Y) {
    test(`pages for ${user}`, async ({ page }) => {
      await signIn(page, user);
      const problems: string[] = [];
      for (const path of paths) {
        await page.goto(path);
        const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
        for (const v of r.violations.filter((x) => x.impact === "serious" || x.impact === "critical")) {
          problems.push(`${path}: ${v.id}: ${v.help} at ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  test("no em dash appears anywhere in the interface", async ({ page }) => {
    test.setTimeout(300_000); // every page for every user
    const found: string[] = [];
    for (const [user, paths] of A11Y) {
      await signIn(page, user);
      for (const path of paths) {
        await page.goto(path);
        if ((await page.locator("body").innerText()).includes("\u2014")) found.push(path);
      }
    }
    expect(found).toEqual([]);
  });
});

const VIEWPORTS = [["phone", 390, 844], ["tablet", 820, 1180], ["laptop", 1366, 768], ["large screen", 1920, 1080]] as const;

test.describe("responsive layout", () => {
  for (const [device, width, height] of VIEWPORTS) {
    test(`${device} (${width}px) has no horizontal scrolling`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const problems: string[] = [];
      const check = async (paths: string[]) => {
        for (const path of paths) {
          await page.goto(path);
          // The dev server can paint a freshly compiled page before its stylesheet arrives; re-measure briefly.
          let overflow = 0;
          for (let i = 0; i < 10; i++) {
            overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            if (overflow <= 1) break;
            await page.waitForTimeout(500);
          }
          if (overflow > 1) problems.push(`${path} overflows by ${overflow}px`);
        }
      };
      await signIn(page, "Adaeze Okafor");
      await check(["/dashboard", "/products", "/eligibility", "/applications", "/applications/new", "/loans", "/profile", "/notifications"]);
      await signIn(page, "Emeka Nwosu");
      await check(["/admin", "/admin/users", "/admin/users/new", "/admin/guarantors", "/admin/guarantors/new", "/admin/products", "/admin/branding", "/admin/settings", "/admin/outbox", "/admin/audit", "/reports", "/verify", "/accounts", "/accounts/loans"]);
      // Administrators cannot open HR or approval pages (no salaries or payslips), so the people who use them are checked.
      await signIn(page, "Kunle Adeyemi");
      await check(["/hr", "/hr/applications", "/hr/staff"]);
      await signIn(page, "Bisi Lawal");
      await check(["/approvals", "/accounts/approvals"]);
      expect(problems).toEqual([]);
      if (width < 1024) {
        // The menu button works once the page has finished loading; retry the click until it does.
        await expect(async () => {
          await page.getByRole("button", { name: "Open navigation" }).click();
          await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
      }
    });
  }
});
