# Adapted from Hugging Face Transformers at commit 7ea2320.
# Copyright 2025 The HuggingFace Inc. team.
# SPDX-License-Identifier: Apache-2.0

import torch


def rotate_queries_or_keys(x, pos):
    _, _, _, dimension = x.size()

    omega = torch.arange(
        dimension // 2,
        dtype=x.dtype,
        device=x.device,
    )
    omega /= dimension / 2.0
    omega = 1.0 / 10000**omega
    frequency = pos.unsqueeze(-1) * omega

    sine = frequency.sin().repeat(1, 1, 1, 2)
    cosine = frequency.cos().repeat(1, 1, 1, 2)

    pairs = x.unflatten(-1, (-1, 2))
    first, second = pairs.unbind(dim=-1)
    rotated = torch.stack((-second, first), dim=-1).flatten(-2)
    return (x * cosine) + (rotated * sine)
