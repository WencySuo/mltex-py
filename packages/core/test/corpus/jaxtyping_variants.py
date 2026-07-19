import torch


def variadic_batch(x: Float[Tensor, "*batch seq dim"]) -> Float[Tensor, "*batch dim"]:
    """Variadic batch dims (*batch edge case)."""
    y = x.mean(-2)
    return y


def broadcast_dims(m: Bool[Tensor, "#b s"], x: Float[Tensor, "b s"]):
    """Broadcastable dims (# edge case)."""
    y = x * x
    return y


def ellipsis_dims(z: Int[Tensor, "..."]):
    """Bare ellipsis dims."""
    s = z.sum()
    return s


def int_dims(x: Float[Tensor, "b 128 4"]):
    """Literal integer dims."""
    y = x + 1
    return y


def mixed_everything(
    q: Float32[Tensor, "*b heads s 64"],
    mask: Bool[Tensor, "#b 1 s s"],
    scale: float,
):
    scores = q @ q.mT * scale
    return scores


def unparseable_dims(x: Float[Tensor, "dim-1 d"]):
    """Symbolic expression dims → raw string fallback (§6.5)."""
    y = x + 1
    return y


def shape_comments(x, w):
    h = x @ w  # (B, T, D)
    z = h.sum(-1)  # (B, T)
    return z
