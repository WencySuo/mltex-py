# Adapted from FilterPy at commit 3b51149.
# Copyright (c) 2015 Roger R. Labbe Jr.
# SPDX-License-Identifier: MIT

from numpy import dot, eye
from numpy.linalg import inv


def predict(state, covariance, transition, process_noise):
    state = dot(transition, state)
    covariance = dot(dot(transition, covariance), transition.T) + process_noise
    return state, covariance


def update(state, covariance, measurement, observation, measurement_noise):
    residual = measurement - dot(observation, state)
    covariance_observation = dot(covariance, observation.T)
    innovation = dot(observation, covariance_observation) + measurement_noise
    gain = dot(covariance_observation, inv(innovation))
    state = state + dot(gain, residual)

    identity_minus_gain = eye(covariance.shape[0]) - dot(gain, observation)
    covariance = (
        dot(dot(identity_minus_gain, covariance), identity_minus_gain.T)
        + dot(dot(gain, measurement_noise), gain.T)
    )
    return state, covariance
