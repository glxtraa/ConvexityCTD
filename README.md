# CTD Lab

Deployable Vercel version of the Treasury Bond Futures CTD and quality delivery-option calculator. The browser application and Colab notebook call the same Python calculation engine in `ctd_model.py`, so price, CTD, and Monte Carlo option calculations stay in sync.

## Links

- [Open the calculator in Colab](https://colab.research.google.com/github/glxtraa/ConvexityCTD/blob/main/Treasury_Bond_Futures_CTD_Delivery_Option_Calculator.ipynb)
- [Source research PDF](./Convexity-Maven-Fat-Cat.pdf)
- [CME conversion-factor source](https://www.cmegroup.com/trading/interest-rates/treasury-conversion-factors.html)

## Vercel

This repository is configured for Vercel static hosting and Python Functions. The UI lives in `index.html`, `styles.css`, and `app.js`; API routes under `api/` serve the CME basket, public Treasury history, and the shared calculation engine. The first deployment can be created from the repository root with the Vercel CLI or by importing this Git repository in Vercel.

## Market-data conventions

- Deliverable bonds and conversion factors refresh from the latest CME workbook; the December 2026 basket CSV is the dated offline fallback.
- Treasury yield history refreshes from FRED's public 10-, 20-, and 30-year series.
- Curve-interpolated individual bond yields are proxies. Edit yields in the web table or load `CUSIP_Yield_Quotes_Template.csv` in Colab for bond-specific quotes.
- Enter a current ZB futures quote in the input. No licensed real-time cash or futures feed is bundled.

## Model scope

The quality-option estimate is a transparent, two-factor Gaussian yield-scenario model. It omits the Treasury futures wild-card, timing, end-of-month, repo financing, and delivery mechanics. It is a research calculator, not an exchange-grade valuation or investment advice.
