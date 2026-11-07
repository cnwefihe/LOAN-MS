import { describe, expect, it } from "vitest";
import { maxPrincipalForInstalment, quoteLoan } from "@/lib/finance/calculator";
import { dec } from "@/lib/finance/money";

// The calculator's "maximum loan" must always have a monthly repayment (amount plus interest) within what is available.
describe("maximum loan fits the monthly limit", () => {
  it("never exceeds the available amount, for any period, and every instalment fits", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 3000; i++) {
      const cap = (1000 + rand() * 900000).toFixed(2);
      for (let n = 1; n <= 12; n++) {
        // The loan is exactly Excel's =ROUND(PV(10%/12, n, -cap), 2); every instalment is the same =ROUND(PMT), within a kobo of the limit.
        const i = dec(10).div(1200);
        const excel = dec(cap).times(dec(1).minus(i.plus(1).pow(-n))).div(i).toDecimalPlaces(2, 4).toFixed(2);
        const max = maxPrincipalForInstalment(cap, n, "reducing_balance", 10);
        expect(max.toFixed(2), `${cap} over ${n}`).toBe(excel);
        const q = quoteLoan(max, n, "reducing_balance", 10);
        expect(q.schedule.every((l) => l.totalDue === q.monthlyInstalment)).toBe(true);
        expect(q.totalRepayable).toBe(dec(q.monthlyInstalment).times(n).toFixed(2));
        expect(dec(q.totalRepayable).minus(q.totalInterest).toFixed(2)).toBe(q.principal);
        expect(dec(q.monthlyInstalment).minus(cap).abs().lessThanOrEqualTo("0.01")).toBe(true);
      }
    }
  });

  it("matches Excel: =PV(10%/12, 12, -114860) is the loan, and the interest is 1,378,320 less the loan", () => {
    const max = maxPrincipalForInstalment("114860", 12, "reducing_balance", 10);
    expect(max.toFixed(2)).toBe("1306476.04"); // exact PV 1,306,476.0377, shown by Excel as 1,306,476.04
    const q = quoteLoan(max, 12, "reducing_balance", 10);
    expect([q.monthlyInstalment, q.totalRepayable, q.totalInterest]).toEqual(["114860.00", "1378320.00", "71843.96"]);
    // Shorter terms are worked out the same way, with n = the months chosen.
    const six = quoteLoan(maxPrincipalForInstalment("114860", 6, "reducing_balance", 10), 6, "reducing_balance", 10);
    expect([six.principal, six.monthlyInstalment, six.totalRepayable]).toEqual(["669497.94", "114860.00", "689160.00"]);
    expect(six.totalInterest).toBe("19662.06"); // 689,160 − 669,497.94
  });

  it("flat rate, still available to administrators: ₦300,000 over 12 months at 10% is ₦330,000, or ₦27,500 a month", () => {
    const q = quoteLoan("300000", 12, "flat", 10);
    expect([q.totalInterest, q.totalRepayable, q.monthlyInstalment]).toEqual(["30000.00", "330000.00", "27500.00"]);
    expect(maxPrincipalForInstalment("27500", 12, "flat", 10).toFixed(2)).toBe("300000.00");
  });
});
