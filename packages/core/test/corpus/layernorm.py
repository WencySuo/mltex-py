import torch


def layernorm(x, gamma, beta, eps):
    """Layer normalization."""
    mu = x.mean()
    var = x.var()
    x_hat = (x - mu) / torch.sqrt(var + eps)
    y = gamma * x_hat + beta
    return y


def layernorm_jaxtyped(
    x: Float[Tensor, "b t d"],
    gamma: Float[Tensor, "d"],
    beta: Float[Tensor, "d"],
    eps: float = 1e-5,
) -> Float[Tensor, "b t d"]:
    mu = x.mean(-1)
    sigma2 = x.var(-1)
    x_hat = (x - mu) / torch.sqrt(sigma2 + eps)
    return gamma * x_hat + beta


def rmsnorm(x, w, eps):
    ms = (x * x).mean()
    x_bar = x / torch.sqrt(ms + eps)
    return w * x_bar
