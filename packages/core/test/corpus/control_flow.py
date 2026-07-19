import torch


def relu_manual(x):
    if x > 0:
        y = x
    else:
        y = 0
    return y


def sign(x):
    if x > 0:
        s = 1
    elif x < 0:
        s = -1
    else:
        s = 0
    return s


def accumulate(xs, N):
    total = 0
    for i in range(N):
        total += xs[i]
    return total


def product(xs, N):
    p = 1
    for i in range(N):
        p *= xs[i]
    return p


def running_max(xs):
    m = float("-inf")
    for x in xs:
        m = max(m, x)
    return m


def collect(N):
    ys = []
    for i in range(N):
        ys.append(i * i)
    return ys


def comprehension(xs):
    ys = [x * 2 for x in xs]
    return ys


def gradient_descent(theta, lr, eps, g):
    while torch.norm(g) > eps:
        theta = theta - lr * g
    return theta


def general_loop(x, T):
    for t in range(T):
        a = x[t] + 1
        b = a * 2
        c = b - a
    return c
