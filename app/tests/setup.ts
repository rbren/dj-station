// Testing-library gives `waitFor` a one-second budget by default, which
// is a statement about how fast the MACHINE is rather than about the
// code. Under a full parallel run — several jsdom workers, one of them
// rendering a fifty-row grid — a poll that would have settled in 20ms on
// an idle box can miss that window, and a test fails for being scheduled
// unluckily rather than for being wrong.
//
// The budget is a ceiling, not a wait: a passing test still returns as
// soon as its condition holds, so this costs nothing when things work
// and only buys patience when the box is busy. Anything genuinely about
// speed is asserted by counting work, not by timing it — see GridPerf.
import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: 5000 });
