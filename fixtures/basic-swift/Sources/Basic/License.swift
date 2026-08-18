// Copyright (c) 2026 The static-x authors.
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met: redistributions of source code must retain the above
// copyright notice, this list of conditions and the following
// disclaimer. Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following
// disclaimer in the documentation and/or other materials provided
// with the distribution. Neither the name of the copyright holder nor
// the names of its contributors may be used to endorse or promote
// products derived from this software without specific prior written
// permission from the copyright holder named at the top of this file.

// This second header is deliberately the same fourteen lines as the
// one above it, and deliberately says none of the words that one says.
// It is here so the exemption above cannot be mistaken for a rule that
// skips whatever sits at the top of a file: that block is passed over
// because of what it declares, and this block is reported because it
// declares nothing. Without a control of the same shape, an exemption
// that had degenerated into "skip the first comment" would still look
// correct from the outside, and every test over this fixture would go
// on passing while the tool quietly stopped reporting a real finding
// in every file whose opening comment ran long enough to count.
//
// Note that this text may not name the three terms the exemption
// matches on. An earlier draft did, while explaining that it did not
// have them, and was silently exempted by the rule it tests.

func licensed() -> Int { 2 }
