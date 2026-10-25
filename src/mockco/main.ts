import { config, mockcoUrl } from "../config.js";
import { createMockco } from "./app.js";

const { app } = createMockco({ chaos: config.chaos });
app.listen(config.mockcoPort, () => console.log(`Northwind Ops (mock company) on ${mockcoUrl()}  chaos=${config.chaos}`));
