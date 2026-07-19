import torch


def softmax(z):
    """Numerically stable softmax."""
    m = z.max()
    e = torch.exp(z - m)
    return e / e.sum()


def logsumexp(z):
    m = z.max()
    return m + torch.log(torch.exp(z - m).sum())


def cross_entropy(logits, target):
    lse = logsumexp(logits)
    return lse - logits[target]


def softmax_loop(z, N):
    """Softmax denominator via accumulation loop (tier-1 reduction)."""
    total = 0
    for i in range(N):
        total += torch.exp(z[i])
    return total


def sum_generator(z, N):
    s = sum(torch.exp(z[i]) for i in range(N))
    return s
