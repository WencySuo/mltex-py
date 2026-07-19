# Extracted from torchvision at commit f23f832.
# Copyright (c) 2016 Soumith Chintala.
# SPDX-License-Identifier: BSD-3-Clause


def forward(self, x):
    identity = x

    out = self.conv1(x)
    out = self.bn1(out)
    out = self.relu(out)

    out = self.conv2(out)
    out = self.bn2(out)

    if self.downsample is not None:
        identity = self.downsample(x)

    out += identity
    out = self.relu(out)

    return out
