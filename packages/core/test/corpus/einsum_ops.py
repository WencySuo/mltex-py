import torch


def matmul_einsum(A, B):
    C = torch.einsum("ij,jk->ik", A, B)
    return C


def batched_matmul(A, B):
    C = torch.einsum("bij,bjk->bik", A, B)
    return C


def trace(A):
    t = torch.einsum("ii->", A)
    return t


def outer_product(a, b):
    M = torch.einsum("i,j->ij", a, b)
    return M


def bilinear_form(x, A, y):
    s = torch.einsum("i,ij,j->", x, A, y)
    return s


def attention_scores_einsum(Q, K):
    S = torch.einsum("bqd,bkd->bqk", Q, K)
    return S


def implicit_output(A, B):
    C = torch.einsum("ij,jk", A, B)
    return C
