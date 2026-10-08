# Package

Turn the confirmed cases into test data and load it into the simulated systems.

## Build the package

One package feeds every simulated system. Its exact format is at the end of this guide (read from the simulated systems themselves), and how to build a good one is described there too. In short: the company's `name` and `currency`, the `customers`, `products` and `contacts` the cases need, and the `cases` themselves (each request as it arrived and the reply that was actually sent).

- Include every customer, product and contact a case mentions, with stock, prices and credit limits that make each case answerable the way it really was.
- Use only the renamed cases.
- Show the person the package before loading it; load only after they agree.

## Load

- Loading needs a setup mandate for each system (see **mandates**). The working AI's mandates must never allow loading.
- Call `load_simulation` in each simulated system with the same package.
- A load only works into an empty system. Incoming requests are dated within the hour before the load, in case order.

## Run again

To run the same cases again under a different setup, or other cases under the same setup:

1. `clear_simulation` in each system — this deletes all test data, including the record of what happened.
2. `load_simulation` again.

Clear and load each count against the setup mandate's daily limit, so one re-run costs two per system. If the limit is too small, propose a new setup mandate with a higher limit.

The real replies stay inside the simulated email system. They are never shown to the working AI; they exist for comparing afterwards.


<!-- generated: package -->

Next: **mandates**.
