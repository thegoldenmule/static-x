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

// This second header is the same shape and the same length as the one
// above it, and carries no copyright, no license, and no SPDX line. It
// is here so the license exemption cannot be mistaken for a rule that
// simply skips whatever sits at the top of a file: the block above is
// exempt because of what it says, and this one is reported because of
// what it does not say. Without a control of the same shape, a broken
// exemption that skipped every leading block would still look correct
// from the outside, and every test over this fixture would keep
// passing while the tool quietly stopped reporting real findings in
// every file whose first comment happened to be long enough to count.

func licensed() -> Int { 2 }
