# Extracted from The Annotated Transformer at commit debc9fd.
# Copyright (c) 2018 Alexander Rush.
# SPDX-License-Identifier: MIT

import math

import torch


def attention(query, key, value, mask=None, dropout=None):
    """Compute scaled dot-product attention."""
    d_k = query.size(-1)
    scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(d_k)
    if mask is not None:
        scores = scores.masked_fill(mask == 0, -1e9)
    probabilities = scores.softmax(dim=-1)
    if dropout is not None:
        probabilities = dropout(probabilities)
    return torch.matmul(probabilities, value), probabilities
