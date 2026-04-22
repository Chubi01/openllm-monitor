import React, { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useStatsStore } from "../store";

const COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];

const PROVIDER_COLORS = {
  ollama: "#F59E0B",
  "ollama-cloud": "#0EA5E9",
  openai: "#10B981",
  openrouter: "#8B5CF6",
  mistral: "#EF4444",
  gemini: "#3B82F6",
  grok: "#6B7280",
};

const providerLabels = {
  ollama: "Ollama Local",
  "ollama-cloud": "Ollama Cloud",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  gemini: "Gemini",
  grok: "Grok",
};

const DashboardCharts = () => {
  const { stats, loading, fetchStats } = useStatsStore();
  const [timeRange, setTimeRange] = useState("24h");

  useEffect(() => {
    fetchStats(timeRange);
  }, [fetchStats, timeRange]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white p-6 rounded-lg shadow animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-1/3 mb-4"></div>
            <div className="h-64 bg-gray-200 rounded"></div>
          </div>
        ))}
      </div>
    );
  }

  const formatTooltipValue = (value, name) => {
    if (name === "cost") return `$${value.toFixed(4)}`;
    if (name === "duration") return `${value}ms`;
    return value;
  };

  return (
    <div className="space-y-6">
      {/* Time Range Selector */}
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-900">Analytics</h2>
        <div className="flex space-x-2">
          {["1h", "6h", "24h", "7d", "30d"].map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1 rounded-md text-sm font-medium ${
                timeRange === range
                  ? "bg-blue-600 text-white"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>{" "}
      {/* Request Volume Chart */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Request Volume Over Time
        </h3>
        <div className="relative">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={stats.requestVolume || []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="timestamp" />
              <YAxis />
              <Tooltip formatter={formatTooltipValue} />
              <Area
                type="monotone"
                dataKey="requests"
                stroke="#3B82F6"
                fill="#3B82F6"
                fillOpacity={0.3}
              />
            </AreaChart>
          </ResponsiveContainer>
          {/* Empty State Overlay */}
          {(!stats.requestVolume ||
            stats.requestVolume.length === 0 ||
            stats.requestVolume.every(
              (item) => (item.requests || 0) === 0
            )) && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
              <div className="text-center p-6">
                <div className="text-4xl mb-3">📈</div>
                <div className="text-lg font-semibold text-blue-700 mb-2">
                  No Request Activity
                </div>
                <div className="text-sm text-gray-600">
                  Request volume will be displayed once API calls are made
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Response Time Chart */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Average Response Time
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={stats.responseTime || []}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" />
            <YAxis />
            <Tooltip formatter={formatTooltipValue} />
            <Legend />
            <Line
              type="monotone"
              dataKey="duration"
              stroke="#10B981"
              strokeWidth={2}
              name="Response Time (ms)"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {" "}
        {/* Provider Distribution */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Provider Distribution
          </h3>
          <div className="relative">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={stats.providerDistribution || []}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) =>
                    `${name} ${(percent * 100).toFixed(0)}%`
                  }
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {(stats.providerDistribution || []).map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={PROVIDER_COLORS[entry.provider] || COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            {/* Empty State Overlay */}
            {(!stats.providerDistribution ||
              stats.providerDistribution.length === 0) && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm">
                <div className="text-center p-6">
                  <div className="text-4xl mb-3">🔌</div>
                  <div className="text-lg font-semibold text-indigo-700 mb-2">
                    No Provider Data
                  </div>
                  <div className="text-sm text-gray-600">
                    Provider usage distribution will appear here
                  </div>
                </div>
              </div>
            )}
          </div>
          {/* Provider Breakdown Table */}
          {(stats.providerBreakdown || []).length > 0 && (
            <div className="mt-4 overflow-hidden border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Tokens</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Avg Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {(stats.providerBreakdown || []).map((p) => (
                    <tr key={p.provider} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-sm font-medium text-gray-900">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-full mr-2"
                          style={{ backgroundColor: PROVIDER_COLORS[p.provider] || "#6B7280" }}
                        />
                        {providerLabels[p.provider] || p.provider}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-600 text-right">{p.totalRequests}</td>
                      <td className="px-4 py-2 text-sm text-gray-600 text-right">{(p.totalTokens || 0).toLocaleString()}</td>
                      <td className="px-4 py-2 text-sm text-gray-600 text-right">{p.avgLatency}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {/* Status Distribution */}
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Status Distribution
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={stats.statusDistribution || []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="status" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="count" fill="#3B82F6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>{" "}
      {/* Token Usage Chart */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Token Usage Over Time
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={stats.tokenUsage || []}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" />
            <YAxis />
            <Tooltip formatter={formatTooltipValue} />
            <Legend />
            <Area
              type="monotone"
              dataKey="inputTokens"
              stackId="1"
              stroke="#3B82F6"
              fill="#3B82F6"
              name="Input Tokens"
            />
            <Area
              type="monotone"
              dataKey="outputTokens"
              stackId="1"
              stroke="#10B981"
              fill="#10B981"
              name="Output Tokens"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Cost Analysis */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Cost Analysis
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={stats.costAnalysis || []}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" />
            <YAxis />
            <Tooltip formatter={formatTooltipValue} />
            <Legend />
            <Line
              type="monotone"
              dataKey="cost"
              stroke="#F59E0B"
              strokeWidth={2}
              name="Cost ($)"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* Model Performance */}
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Model Performance Comparison
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={stats.modelPerformance || []}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="model" />
            <YAxis />
            <Tooltip formatter={formatTooltipValue} />
            <Legend />
            <Bar
              dataKey="avgDuration"
              fill="#3B82F6"
              name="Avg Duration (ms)"
            />
            <Bar dataKey="successRate" fill="#10B981" name="Success Rate (%)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default DashboardCharts;
