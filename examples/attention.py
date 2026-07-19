"""Example workflow for manual MathLens testing.

Covers: hover (F0), CodeLens (F1), panel (F2), selection (F3),
workflow/lemmas (F4), two-column + PDF (F5), loops/cases (F6),
directives (F7), jaxtyping shapes (F8).
"""

import math

import torch
from jaxtyping import Float
from torch import Tensor


def softmax(z: Float[Tensor, "n"]) -> Float[Tensor, "n"]:
    """Numerically stable softmax."""
    z_max = z.max()
    e = torch.exp(z - z_max)
    return e / e.sum()


def attention(
    Q: Float[Tensor, "t d"],
    K: Float[Tensor, "t d"],
    V: Float[Tensor, "t d"],
) -> Float[Tensor, "t d"]:
    """Scaled dot-product attention."""
    d = Q.shape[-1]
    alpha_hat = Q @ K.T / math.sqrt(d)  # tex: \hat{\alpha}
    A = softmax(alpha_hat)
    return A @ V


def layernorm(x, gamma, beta, eps=1e-5):
    """LayerNorm with a piecewise guard and elementwise ops."""
    mu = x.mean()
    var = x.var()
    if var > eps:
        x_hat = (x - mu) / torch.sqrt(var + eps)
    else:
        x_hat = x - mu
    return gamma * x_hat + beta


def gru_step(h, xs):
    """Recurrence: should render h_t = f(h_{t-1}, x_t)."""
    for t in range(len(xs)):
        h = torch.tanh(h + xs[t])
    return h


def total_loss(losses):
    """Reduction: should render as a summation."""
    acc = 0.0
    for i in range(len(losses)):
        acc += losses[i]
    return acc / len(losses)


def bilinear(a, W, b):
    """Einsum: should expand to an explicit double sum."""
    return torch.einsum("i,ij,j->", a, W, b)
