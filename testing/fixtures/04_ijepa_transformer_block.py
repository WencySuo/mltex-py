# Adapted from Hugging Face Transformers at commit 7ea2320.
# Copyright 2018 The Hugging Face team.
# SPDX-License-Identifier: Apache-2.0


def forward(self, hidden_states, attention_mask=None):
    residual = hidden_states
    hidden_states = self.layernorm_before(hidden_states)
    hidden_states, _ = self.attention(hidden_states, attention_mask)
    hidden_states = self.dropout(hidden_states)
    hidden_states = hidden_states + residual

    residual = hidden_states
    hidden_states = self.layernorm_after(hidden_states)
    hidden_states = self.mlp(hidden_states)
    hidden_states = self.dropout(hidden_states)
    hidden_states = hidden_states + residual

    return hidden_states
