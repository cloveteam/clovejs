import { di } from "clovejs"

// Read at module scope on purpose: this is the case the loader has to satisfy,
// since the scanner evaluates this file during boot.
const snapshot = {
  fromEnv: process.env.CLOVE_FIXTURE_PLAIN ?? null,
  fromModeFile: process.env.CLOVE_FIXTURE_MODE ?? null,
  fromLocalFile: process.env.CLOVE_FIXTURE_LOCAL ?? null,
  overridden: process.env.CLOVE_FIXTURE_OVERRIDE ?? null,
  quoted: process.env.CLOVE_FIXTURE_QUOTED ?? null,
}

export default di({
  lifetime: "singleton",
  value: snapshot,
})
